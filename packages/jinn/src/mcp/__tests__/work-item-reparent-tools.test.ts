import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureSessionCapability } from "../identity.js";
import type { JinnMcpContext, JinnMcpTool } from "../toolkit.js";
import { inProcessGatewayFetch, seedPlatformOrg } from "./helpers/in-process-gateway.js";

/* Reparenting through MCP: no tool of its own, only `parentId` on edit_work_item
 * (a Todo id makes a sub-task, null detaches), driven through the real API. */

process.env.JINN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-mcp-reparent-home-"));

let buildWorkItemTools: typeof import("../work-item-tools.js").buildWorkItemTools;
let api: typeof import("../../gateway/api.js");
let registry: typeof import("../../sessions/registry.js");
let store: typeof import("../../work-items/store.js");

function tool(name: string): JinnMcpTool {
  const found = buildWorkItemTools().find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

function ctxFor(callerSessionId: string): JinnMcpContext {
  return {
    gatewayUrl: "http://gateway.test",
    fetchFn: inProcessGatewayFetch(api),
    callerSessionId,
    sessionCapability: ensureSessionCapability(callerSessionId),
  };
}

const sessionOf = (employee: string) => registry.createSession({ engine: "codex", source: "web", sourceRef: `mcp-reparent-${employee}`, title: employee, employee });
const edit = (ctx: JinnMcpContext, args: Record<string, unknown>) => tool("edit_work_item").handler(args, ctx);

beforeAll(async () => {
  seedPlatformOrg(process.env.JINN_HOME!);
  ({ buildWorkItemTools } = await import("../work-item-tools.js"));
  api = await import("../../gateway/api.js");
  registry = await import("../../sessions/registry.js");
  store = await import("../../work-items/store.js");
  (await import("../../shared/db.js")).initDb();
});

describe("edit_work_item { parentId }", () => {
  it("detaches a sub-task to a root and makes a root a sub-task again, children moving with it", async () => {
    const ctx = ctxFor(sessionOf("platform-dev").id);
    const objective = store.createWorkItem({ title: "objective", assignee: "platform-dev" });
    const child = store.createWorkItem({ title: "child", parentId: objective.id, assignee: "platform-dev" });
    const grandchild = store.createWorkItem({ title: "grandchild", parentId: child.id, assignee: "platform-dev" });

    const detached = (await edit(ctx, { id: child.id, parentId: null })) as { parentId: string | null; rootId: string; depth: number };
    expect(detached).toMatchObject({ parentId: null, rootId: child.id, depth: 0 });
    expect(store.getWorkItem(grandchild.id)).toMatchObject({ rootId: child.id, depth: 1 });

    const attached = (await edit(ctx, { id: child.id, parentId: objective.id, title: "child (re-homed)" })) as { parentId: string; rootId: string };
    expect(attached).toMatchObject({ parentId: objective.id, rootId: objective.id });
    expect(store.getWorkItem(child.id)!.title).toBe("child (re-homed)");
    expect(store.getWorkItem(grandchild.id)).toMatchObject({ rootId: objective.id, depth: 2 });
  });

  it("refuses a cycle and writes nothing, even alongside a content edit", async () => {
    const ctx = ctxFor(sessionOf("platform-dev").id);
    const root = store.createWorkItem({ title: "cycle root", assignee: "platform-dev" });
    const child = store.createWorkItem({ title: "cycle child", parentId: root.id, assignee: "platform-dev" });
    await expect(edit(ctx, { id: root.id, parentId: child.id, title: "never saved" })).rejects.toThrow(/already beneath/);
    expect(store.getWorkItem(root.id)).toMatchObject({ title: "cycle root", parentId: null });
  });

  it("needs standing over the Todo and over the new parent", async () => {
    const dev = ctxFor(sessionOf("platform-dev").id);
    const outsider = ctxFor(sessionOf("outsider").id);
    const mine = store.createWorkItem({ title: "mine", assignee: "platform-dev" });
    const theirs = store.createWorkItem({ title: "theirs", assignee: "outsider" });
    await expect(edit(dev, { id: mine.id, parentId: theirs.id })).rejects.toThrow(/403|standing|owner/i);
    await expect(edit(outsider, { id: mine.id, parentId: null })).rejects.toThrow(/403|standing|owner/i);
    expect(store.getWorkItem(mine.id)!.parentId).toBeNull();
  });

  it("keeps sprint and parentId as separate edits", async () => {
    const ctx = ctxFor(sessionOf("platform-dev").id);
    const todo = store.createWorkItem({ title: "both", assignee: "platform-dev" });
    await expect(edit(ctx, { id: todo.id, parentId: null, sprint: "active" })).rejects.toThrow(/separate edits/);
  });
});
