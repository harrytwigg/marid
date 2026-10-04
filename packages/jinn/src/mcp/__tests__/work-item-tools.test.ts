import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CALLER_SESSION_HEADER, ensureSessionCapability } from "../identity.js";
import type { JinnMcpContext, JinnMcpTool } from "../toolkit.js";
import { inProcessGatewayFetch, seedPlatformOrg } from "./helpers/in-process-gateway.js";

process.env.JINN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-mcp-work-items-home-"));

let buildTools: typeof import("../server.js").buildTools;
let buildWorkItemTools: typeof import("../work-item-tools.js").buildWorkItemTools;
let WORK_ITEM_SEARCH_LIMIT_MAX: typeof import("../work-item-tools.js").WORK_ITEM_SEARCH_LIMIT_MAX;
let WORK_ITEM_QUERY_CHAR_CAP: typeof import("../work-item-tools.js").WORK_ITEM_QUERY_CHAR_CAP;

interface SeenCall {
  url: string;
  method: string;
  body?: unknown;
  headers: Record<string, string>;
}

/** A multipart body as plain data: text fields verbatim, files as `<name:bytes>`. */
function formFields(form: FormData): Record<string, string> {
  return Object.fromEntries([...form.entries()].map(([k, v]) => [k, typeof v === "string" ? v : `<${v.name}:${v.size}>`]));
}

function stub(
  responder: (call: SeenCall) => { status: number; body: unknown },
  callerSessionId: string | null = "session-test",
  sessionCapability = callerSessionId ? "cap-test" : undefined,
) {
  const calls: SeenCall[] = [];
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const call: SeenCall = {
      url: typeof input === "string" ? input : input.toString(),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body instanceof FormData ? formFields(init.body) : undefined,
      headers: (init?.headers as Record<string, string>) ?? {},
    };
    calls.push(call);
    const { status, body } = responder(call);
    return { status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) } as unknown as Response;
  }) as unknown as typeof fetch;
  return {
    calls,
    ctx: {
      gatewayUrl: "http://127.0.0.1:7777",
      fetchFn,
      ...(callerSessionId ? { callerSessionId } : {}),
      ...(sessionCapability ? { sessionCapability } : {}),
    } satisfies JinnMcpContext,
  };
}

function tool(name: string): JinnMcpTool {
  const t = buildWorkItemTools().find((t) => t.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

describe("work-item tools — registry + schemas", () => {
  it("exposes the generic Todo verbs and no approval verbs", () => {
    expect(buildWorkItemTools().map((t) => t.name)).toEqual([
      "list_work_items",
      "get_work_item",
      "get_work_item_tree",
      "search_work_items",
      "create_work_item",
      "update_work_item",
      "edit_work_item",
      "assign_work_item",
      "archive_work_item", "dispatch_work_item", "land_on_work_item",
      "comment_work_item",
      "list_work_item_comments",
      "attach_to_work_item",
      "list_work_item_attachments",
      "link_work_items",
      "unlink_work_items",
      "label_work_item",
      "create_label",
      "list_labels", "set_work_item_dispatch",
      "list_departments",
    ]);
    const names = buildTools().map((t) => t.name).sort();
    expect(names).toContain("create_work_item");
    expect(names).toContain("assign_work_item");
    expect(names.some((n) => /approval/.test(n))).toBe(false);
    expect(names).toContain("archive_work_item");
    expect(names.some((n) => /cancel/i.test(n) && /work_item/.test(n))).toBe(false);
    expect(names).toHaveLength(51);
  });

  it("positions list as recent/filter summaries and search as text/filter hits", () => {
    expect(tool("list_work_items").description).toMatch(/recent or filtered/i);
    expect(tool("list_work_items").description).toMatch(/compact summaries/i);
    expect(tool("search_work_items").description).toMatch(/by text/i);
    expect(tool("search_work_items").description).toMatch(/structured filters/i);
  });

  it("makes Todo hierarchy explicit on the list surface", () => {
    const properties = tool("list_work_items").inputSchema.properties;
    expect(properties.parentId).toMatchObject({ pattern: "^[A-Z]{3}-[1-9][0-9]*$" });
    expect(properties.rootId).toMatchObject({ pattern: "^[A-Z]{3}-[1-9][0-9]*$" });
    expect(tool("list_work_items").description).toMatch(/roots and sub-tasks/i);
  });

  it("update schema allows manual start but leaves cancelling to archive", () => {
    const createProps = tool("create_work_item").inputSchema.properties;
    expect(Object.keys(createProps).sort()).toEqual(
      ["autoStart", "body", "department", "dueAt", "idempotencyKey", "labels", "parentId", "priority", "sprint", "title"].sort(),
    );
    const status = tool("update_work_item").inputSchema.properties.status as { enum: string[] };
    expect(status.enum).toEqual(["backlog", "executing", "in_review", "blocked", "done"]);
    expect(status.enum).not.toContain("cancelled");
    expect(tool("update_work_item").inputSchema.properties.asOperator).toMatchObject({ type: "boolean", description: expect.stringMatching(/coordinator.*done.*reason/i) });
    expect(tool("update_work_item").inputSchema.properties).not.toHaveProperty("acknowledgeEscalated");
    expect(tool("get_work_item").inputSchema.properties.id).toMatchObject({ pattern: "^[A-Z]{3}-[1-9][0-9]*$" });
  });

  it("ships the generic Todo doctrine in the repo template CLAUDE.md", () => {
    const template = fs.readFileSync(path.join(process.cwd(), "template", "CLAUDE.md"), "utf-8");
    const todoSkill = fs.readFileSync(
      path.join(process.cwd(), "template", "skills", "todo-handling", "SKILL.md"),
      "utf-8",
    );
    expect(template).toContain("| Todos | `skills/todo-handling/SKILL.md` |");
    expect(template).toContain("Keep the Todo ledger current.");
    expect(todoSkill).toContain("create_work_item");
    expect(todoSkill).toContain("One operator outcome should normally map to one root Todo.");
    expect(todoSkill).toContain("A checklist does not imply one Todo per item.");
    expect(todoSkill).toContain("Only independently assignable or independently reviewable deliverables become child Todos.");
    expect(todoSkill).toContain("No agent marks a Todo `done`.");
    expect(template).not.toContain(["", "Users", ""].join("/"));
  });
});

describe("work-item tools — unit (stub gateway)", () => {
  it("accepts a company-derived canonical ID and forwards it unchanged", async () => {
    const { calls, ctx } = stub(() => ({ status: 200, body: { id: "ICI-42", title: "Company Todo" } }));
    await expect(tool("get_work_item").handler({ id: "ICI-42" }, ctx)).resolves.toMatchObject({ id: "ICI-42" });
    expect(calls[0].url).toBe("http://127.0.0.1:7777/api/work-items/ICI-42");
  });

  it.each(["wi_0123456789ab", "JIN-0", "JIN-01", "JIN-9007199254740992", " JIN-1 "])(
    "rejects noncanonical Todo id %s before contacting the gateway",
    async (id) => {
      for (const name of ["get_work_item", "update_work_item", "assign_work_item", "archive_work_item"]) {
        const { calls, ctx } = stub(() => ({ status: 500, body: { error: "must not run" } }));
        const args = name === "update_work_item"
          ? { id, status: "executing" }
          : name === "assign_work_item"
            ? { id, assignee: "platform-worker" }
            : { id };
        await expect(tool(name).handler(args, ctx)).rejects.toThrow(/canonical Todo ID/i);
        expect(calls).toEqual([]);
      }
    },
  );

  it("preserves the route receipt at the MCP result root and points at the persisted chat receipt", async () => {
    const { ctx } = stub(() => ({
      status: 201,
      body: { workItem: { id: "JIN-101", title: "Receipt", status: "backlog" }, activityReceiptId: "todo:JIN-101" },
    }));
    const out = await tool("create_work_item").handler({ title: "Receipt" }, ctx) as Record<string, unknown>;
    expect(out.activityReceiptId).toBe("todo:JIN-101");
    expect(out.hint).toMatch(/Preview or Open the persisted activity receipt in this chat\./);
  });

  it("list passes filters and returns hierarchy-aware compact summaries", async () => {
    const { calls, ctx } = stub(() => ({
      status: 200,
      body: {
        workItems: [{
          id: "JIN-2",
          title: "T",
          body: "MUST NOT LEAK",
          status: "blocked",
          source: "session",
          version: 7,
          parentId: "JIN-1",
          rootId: "JIN-1",
          depth: 1,
        }],
      },
    }));
    const out = (await tool("list_work_items").handler({
      status: "blocked",
      source: "session",
      assignee: "qa",
      parentId: "JIN-1",
      rootId: "JIN-1",
      limit: 99,
    }, ctx)) as {
      workItems: Array<Record<string, unknown>>;
    };
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/api/work-items");
    expect(url.searchParams.get("status")).toBe("blocked");
    expect(url.searchParams.get("source")).toBe("session");
    expect(url.searchParams.get("assignee")).toBe("qa");
    expect(url.searchParams.get("parent")).toBe("JIN-1");
    expect(url.searchParams.get("root")).toBe("JIN-1");
    // Raised caps (Todos v2): 99 is within the new max of 100, so it passes through unclamped.
    expect(url.searchParams.get("limit")).toBe("99");
    expect(out.workItems[0]).toEqual({
      id: "JIN-2",
      title: "T",
      status: "blocked",
      assignee: null,
      department: null,
      source: "session",
      parentId: "JIN-1",
      rootId: "JIN-1",
      depth: 1,
      version: 7,
      updatedAt: null,
    });
  });

  it("get returns full Todo detail without projecting Workflow run state", async () => {
    const { ctx } = stub(() => ({
      status: 200,
      body: {
        workItem: {
          id: "JIN-2",
          title: "WF",
          body: "body",
          status: "in_review",
          rounds: 1,
          budgetUsd: 5,
          source: "workflow",
        },
        spendUsd: 1.25,
      },
    }));
    const out = (await tool("get_work_item").handler({ id: "JIN-2" }, ctx)) as Record<string, unknown>;
    expect(out).toMatchObject({ spendUsd: 1.25 });
    expect(out).not.toHaveProperty("workflowRun");
    expect(out.workItem).toMatchObject({ rounds: 1 });
  });

  it("get_work_item_tree hits the tree route and returns the subtree with a hint", async () => {
    const { calls, ctx } = stub(() => ({
      status: 200,
      body: { tree: { root: { id: "JIN-5", children: [{ id: "JIN-6", children: [] }] }, totals: { backlog: 2 }, spendUsd: 0 } },
    }));
    const out = (await tool("get_work_item_tree").handler({ id: "JIN-5" }, ctx)) as Record<string, unknown>;
    expect(calls[0].method).toBe("GET");
    expect(new URL(calls[0].url).pathname).toBe("/api/work-items/JIN-5/tree");
    expect(out.tree).toMatchObject({ spendUsd: 0 });
    expect(out.hint).toMatch(/get_work_item/);
    await expect(tool("get_work_item_tree").handler({ id: "wi_notatodo" }, ctx)).rejects.toThrow(/canonical Todo ID/);
  });

  it("create forwards parentId/priority/dueAt after local validation", async () => {
    const { calls, ctx } = stub(() => ({ status: 201, body: { workItem: { id: "JIN-9" } } }), "sess-caller");
    await tool("create_work_item").handler(
      { title: "Sub", parentId: "JIN-5", priority: 1, dueAt: "2026-08-01T00:00:00.000Z" },
      ctx,
    );
    expect(calls[0].body).toMatchObject({ title: "Sub", parentId: "JIN-5", priority: 1, dueAt: "2026-08-01T00:00:00.000Z" });
    await expect(tool("create_work_item").handler({ title: "Bad", parentId: "nope" }, ctx)).rejects.toThrow(/parentId must be a canonical Todo ID/);
    await expect(tool("create_work_item").handler({ title: "Bad", priority: 7 }, ctx)).rejects.toThrow(/priority must be an integer 0\.\.3/);
  });

  it("search uses the search route, caps hostile input locally, and returns no body dumps", async () => {
    const { calls, ctx } = stub(() => ({ status: 200, body: { workItems: [{ id: "JIN-104", title: "Needle", body: "SECRET", status: "backlog", source: "session" }] } }));
    const out = (await tool("search_work_items").handler(
      { text: "%_\\ hostile", status: "backlog", department: "platform", limit: 999 },
      ctx,
    )) as { workItems: Array<Record<string, unknown>> };
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/api/search/work-items");
    expect(url.searchParams.get("text")).toBe("%_\\ hostile");
    expect(url.searchParams.get("status")).toBe("backlog");
    expect(url.searchParams.get("department")).toBe("platform");
    expect(url.searchParams.get("limit")).toBe(String(WORK_ITEM_SEARCH_LIMIT_MAX));
    expect(out.workItems[0]).not.toHaveProperty("body");
    await expect(tool("search_work_items").handler({ text: "x".repeat(WORK_ITEM_QUERY_CHAR_CAP + 1) }, ctx)).rejects.toThrow(
      /text is too long.*shorten/,
    );
  });

  it("create requires caller identity, and posts session provenance", async () => {
    const anon = stub(() => ({ status: 201, body: {} }), null);
    await expect(tool("create_work_item").handler({ title: "T" }, anon.ctx)).rejects.toThrow(/caller identity unavailable/i);

    const { calls, ctx } = stub(() => ({ status: 201, body: { workItem: { id: "JIN-103", title: "T", status: "backlog" } } }), "sess-caller");
    await tool("create_work_item").handler({ title: "T", body: "B" }, ctx);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("http://127.0.0.1:7777/api/work-items");
    expect(calls[0].headers[CALLER_SESSION_HEADER]).toBe("sess-caller");
    expect(calls[0].body).toEqual({ title: "T", body: "B" });
  });

  it("create refuses caller-supplied provenance instead of forwarding spoofable source/sourceRef", async () => {
    const { calls, ctx } = stub(() => ({ status: 201, body: {} }), "sess-caller");
    await expect(
      tool("create_work_item").handler({ title: "Spoof", provenance: { source: "workflow", sourceRef: "workflow:wf:run" } }, ctx),
    ).rejects.toThrow(/cron and delegation create their own records.*source=workflow is historical audit provenance and is not currently minted/i);
    expect(calls).toHaveLength(0);
  });

  it("update is identity-gated, leaves the lane to the gateway, and readable gateway refusals reach the caller", async () => {
    const anon = stub(() => ({ status: 200, body: {} }), null);
    await expect(tool("update_work_item").handler({ id: "JIN-1", status: "blocked" }, anon.ctx)).rejects.toThrow(/caller identity unavailable/i);
    const { calls, ctx } = stub(() => ({ status: 403, body: { error: "self-review ban — use the human review surface" } }), "sess-1");
    // Not a client-side refusal: the status is a real one, so it goes to the gateway, which decides the lane.
    await expect(tool("update_work_item").handler({ id: "JIN-1", status: "cancelled", note: "drop" }, ctx)).rejects.toThrow(/refused \(403\).*human review surface/i);
    await expect(tool("update_work_item").handler({ id: "JIN-1", status: "done" }, ctx)).rejects.toThrow(/human review surface/i);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("http://127.0.0.1:7777/api/work-items/JIN-1/status");
    expect(calls[0].body).toEqual({ status: "cancelled", note: "drop" });
    expect(calls[1].body).toEqual({ status: "done" });
    await expect(tool("update_work_item").handler({ id: "JIN-1", status: "assigned" }, ctx)).rejects.toThrow(/status must be one of/i);
    await expect(tool("update_work_item").handler({ id: "JIN-1", status: "escalated" }, ctx)).rejects.toThrow(/status must be one of/i);
    expect(calls).toHaveLength(2);
  });

  it("accepts executing and sends it through the guarded status route", async () => {
    const { calls, ctx } = stub(() => ({ status: 200, body: { workItem: { id: "JIN-1", status: "executing" } } }), "sess-1");

    await expect(tool("update_work_item").handler({ id: "JIN-1", status: "executing" }, ctx)).resolves.toMatchObject({
      workItem: { status: "executing" },
    });
    expect(calls).toEqual([expect.objectContaining({ method: "POST", url: "http://127.0.0.1:7777/api/work-items/JIN-1/status", body: { status: "executing" } })]);
  });

  it("forwards asOperator for the gateway to authorize, and omits it when unasked", async () => {
    const { calls, ctx } = stub(() => ({ status: 200, body: { workItem: { id: "JIN-1", status: "done" } } }), "sess-1");

    await tool("update_work_item").handler({ id: "JIN-1", status: "done", note: "shipped", asOperator: true }, ctx);
    await tool("update_work_item").handler({ id: "JIN-1", status: "done" }, ctx);

    expect(calls.map((c) => c.body)).toEqual([
      { status: "done", note: "shipped", asOperator: true },
      { status: "done" },
    ]);
  });

  it("assign validates through the route and maps readable 400 near-match errors", async () => {
    const { calls, ctx } = stub(() => ({ status: 400, body: { error: 'unknown employee "platfrom-dev". Did you mean "platform-dev"? Check find_employees.' } }), "sess-1");
    await expect(tool("assign_work_item").handler({ id: "JIN-1", assignee: "platfrom-dev" }, ctx)).rejects.toThrow(
      /Did you mean "platform-dev".*find_employees/,
    );
    expect(calls[0].url).toBe("http://127.0.0.1:7777/api/work-items/JIN-1/assign");
    expect(calls[0].body).toEqual({ assignee: "platfrom-dev" });
  });

  it("archive is identity-gated and posts to the non-deleting archive route", async () => {
    const anon = stub(() => ({ status: 200, body: {} }), null);
    await expect(tool("archive_work_item").handler({ id: "JIN-1", note: "stale" }, anon.ctx)).rejects.toThrow(/caller identity unavailable/i);

    const { calls, ctx } = stub(() => ({ status: 200, body: { workItem: { id: "JIN-1", status: "cancelled" }, archived: true } }), "sess-1");
    const out = (await tool("archive_work_item").handler({ id: "JIN-1", note: "stale cleanup" }, ctx)) as { archived: boolean; workItem: { status: string } };
    expect(out).toMatchObject({ archived: true, workItem: { status: "cancelled" } });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("http://127.0.0.1:7777/api/work-items/JIN-1/archive");
    expect(calls[0].body).toEqual({ note: "stale cleanup" });
  });
});

type Api = typeof import("../../gateway/api.js");
type Registry = typeof import("../../sessions/registry.js");
type Store = typeof import("../../work-items/store.js");
let api: Api;
let registry: Registry;
let store: Store;

function ctxFor(callerSessionId?: string, capability: "valid" | "none" | string = "valid"): JinnMcpContext {
  return {
    gatewayUrl: "http://gateway.test",
    fetchFn: inProcessGatewayFetch(api),
    callerSessionId,
    sessionCapability: callerSessionId && capability !== "none"
      ? capability === "valid" ? ensureSessionCapability(callerSessionId) : capability
      : undefined,
  };
}

beforeAll(async () => {
  seedPlatformOrg(process.env.JINN_HOME!);
  ({ buildTools } = await import("../server.js"));
  ({ buildWorkItemTools, WORK_ITEM_SEARCH_LIMIT_MAX, WORK_ITEM_QUERY_CHAR_CAP } = await import("../work-item-tools.js"));
  api = await import("../../gateway/api.js");
  registry = await import("../../sessions/registry.js");
  store = await import("../../work-items/store.js");
  (await import("../../shared/db.js")).initDb();
});

describe("work-item tools — integration against the real API + store", () => {
  it("create → search → assign → update → read round-trips through MCP only", async () => {
    const caller = registry.createSession({ engine: "codex", source: "web", sourceRef: "caller", title: "caller", employee: "platform-dev" });
    const ctx = ctxFor(caller.id);

    const created = (await tool("create_work_item").handler(
      { title: "Polish narwhal queue", body: "Literal %_\\ body" },
      ctx,
    )) as { workItem: { id: string } };
    expect(created.workItem.id).toBeTruthy();

    const found = (await tool("search_work_items").handler({ text: "Literal %_\\", status: "backlog" }, ctx)) as {
      workItems: Array<{ id: string }>;
    };
    expect(found.workItems.map((w) => w.id)).toContain(created.workItem.id);

    const assigned = (await tool("assign_work_item").handler({ id: created.workItem.id, assignee: "platform-dev" }, ctx)) as { workItem: { assignee: string; department: string; status: string } };
    // Assigning never moves the Todo: a backlog Todo with an assignee is what "assigned" now means.
    expect(assigned.workItem).toMatchObject({ assignee: "platform-dev", department: "platform", status: "backlog" });

    const started = (await tool("update_work_item").handler({ id: created.workItem.id, status: "executing" }, ctx)) as {
      workItem: { status: string };
    };
    expect(started.workItem.status).toBe("executing");

    const reviewed = (await tool("update_work_item").handler({ id: created.workItem.id, status: "in_review", note: "done" }, ctx)) as {
      workItem: { status: string };
    };
    expect(reviewed.workItem.status).toBe("in_review");
    // A review that sends work back is an ordinary agent move now, not an
    // illegal edge the agent has to route through a human to perform.
    const bounced = (await tool("update_work_item").handler({ id: created.workItem.id, status: "executing" }, ctx)) as {
      workItem: { status: string };
    };
    expect(bounced.workItem.status).toBe("executing");

    const read = (await tool("get_work_item").handler({ id: created.workItem.id }, ctx)) as {
      workItem: Record<string, unknown>;
      spendUsd: number;
    };
    expect(read.workItem).not.toHaveProperty("acceptance");
    expect(read.workItem).not.toHaveProperty("verifyPolicy");
    expect(read.spendUsd).toBe(0);
  });

  it("rejects unrelated self-assignment and terminal assignment while preserving authorized reassignment and unassigned self-claim", async () => {
    const owner = registry.createSession({ engine: "codex", source: "web", sourceRef: "assign-owner", title: "assign owner", employee: "platform-dev" });
    const outsider = registry.createSession({ engine: "codex", source: "web", sourceRef: "assign-outsider", title: "assign outsider", employee: "outsider" });
    const manager = registry.createSession({ engine: "codex", source: "web", sourceRef: "assign-manager", title: "assign manager", employee: "platform-manager" });
    const root = registry.createSession({ engine: "codex", source: "web", sourceRef: "assign-root", title: "assign root", employee: "coo" });

    const protectedItem = store.createWorkItem({ title: "Protected assignment", status: "backlog", assignee: "platform-dev", source: "session" });
    await expect(tool("assign_work_item").handler({ id: protectedItem.id, assignee: "outsider" }, ctxFor(outsider.id))).rejects.toThrow(
      /403.*does not own|403.*cannot assign/i,
    );
    expect(store.getWorkItem(protectedItem.id)?.assignee).toBe("platform-dev");

    const ownerAssigned = (await tool("assign_work_item").handler({ id: protectedItem.id, assignee: "outsider" }, ctxFor(owner.id))) as {
      workItem: { assignee: string };
    };
    expect(ownerAssigned.workItem.assignee).toBe("outsider");

    const managedItem = store.createWorkItem({ title: "Manager assignment", status: "backlog", assignee: "platform-dev", source: "session" });
    expect(((await tool("assign_work_item").handler({ id: managedItem.id, assignee: "outsider" }, ctxFor(manager.id))) as { workItem: { assignee: string } }).workItem.assignee).toBe("outsider");
    const rootItem = store.createWorkItem({ title: "Root assignment", status: "backlog", assignee: "platform-dev", source: "session" });
    expect(((await tool("assign_work_item").handler({ id: rootItem.id, assignee: "outsider" }, ctxFor(root.id))) as { workItem: { assignee: string } }).workItem.assignee).toBe("outsider");

    const unassigned = store.createWorkItem({ title: "Claimable backlog", status: "backlog", assignee: null, source: "human" });
    const claimed = (await tool("assign_work_item").handler({ id: unassigned.id, assignee: "outsider" }, ctxFor(outsider.id))) as {
      workItem: { assignee: string; status: string };
    };
    expect(claimed.workItem).toMatchObject({ assignee: "outsider", status: "backlog" });

    const terminal = store.createWorkItem({ title: "Closed assignment", status: "done", assignee: "platform-dev", source: "session" });
    await expect(tool("assign_work_item").handler({ id: terminal.id, assignee: "outsider" }, ctxFor(owner.id))).rejects.toThrow(
      /cannot assign.*done|terminal/i,
    );
    expect(store.getWorkItem(terminal.id)?.assignee).toBe("platform-dev");
  });

  it("linked executor can move its delegated item to in_review, but cannot mark it done", async () => {
    const coo = registry.createSession({ engine: "codex", source: "web", sourceRef: "coo", title: "coo" });
    const delegated = (await buildTools().find((t) => t.name === "delegate_task")!.handler(
      { task: "Execute the check", engine: "codex", title: "Executor check" },
      ctxFor(coo.id),
    )) as { workItemId: string; sessionId: string };
    expect(store.getWorkItem(delegated.workItemId)?.status).toBe("executing");

    const execCtx = ctxFor(delegated.sessionId);
    const moved = (await tool("update_work_item").handler({ id: delegated.workItemId, status: "in_review", note: "ready" }, execCtx)) as {
      workItem: { status: string };
    };
    expect(moved.workItem.status).toBe("in_review");
    await expect(tool("update_work_item").handler({ id: delegated.workItemId, status: "done" }, execCtx)).rejects.toThrow(
      /operator's decision.*in_review/i,
    );
  });

  it("requires a server-minted session capability, and no agent session closes, only the coordinator for the operator", async () => {
    const reviewer = registry.createSession({ engine: "codex", source: "web", sourceRef: "qa-reviewer", title: "qa reviewer" });
    const operatorSource = registry.createSession({ engine: "codex", source: "web", sourceRef: "operator-source", title: "operator source" });
    const executor = registry.createSession({
      engine: "codex",
      source: "web",
      sourceRef: "qa-executor",
      title: "qa executor",
      parentSessionId: reviewer.id,
    });
    const item = store.createWorkItem({ title: "Identity authority close", status: "in_review", source: "delegation", sourceRef: `delegate:${reviewer.id}:qa` });
    store.linkSession(item.id, executor.id);

    await expect(tool("update_work_item").handler({ id: item.id, status: "done" }, ctxFor("ghost-session-not-in-db"))).rejects.toThrow(
      /unidentified.*tool.*caller|caller identity unavailable/i,
    );
    expect(store.getWorkItem(item.id)?.status).toBe("in_review");

    await expect(tool("update_work_item").handler({ id: item.id, status: "done" }, ctxFor(reviewer.id, "none"))).rejects.toThrow(
      /caller identity unavailable|unidentified/i,
    );
    expect(store.getWorkItem(item.id)?.status).toBe("in_review");

    await expect(tool("update_work_item").handler({ id: item.id, status: "done" }, ctxFor(operatorSource.id, "none"))).rejects.toThrow(
      /caller identity unavailable|unidentified/i,
    );
    expect(store.getWorkItem(item.id)?.status).toBe("in_review");

    await expect(tool("update_work_item").handler({ id: item.id, status: "done" }, ctxFor(executor.id))).rejects.toThrow(
      /operator's decision.*in_review/i,
    );
    expect(store.getWorkItem(item.id)?.status).toBe("in_review");

    // There is no agent close path at all: the session that delegated the work cannot
    // close it either, and neither can a coordinator that does not say it acts for the operator.
    await expect(tool("update_work_item").handler({ id: item.id, status: "done" }, ctxFor(reviewer.id))).rejects.toThrow(
      /operator's decision.*in_review/i,
    );
    await expect(tool("update_work_item").handler({ id: item.id, status: "done" }, ctxFor(operatorSource.id))).rejects.toThrow(
      /operator's decision.*in_review/i,
    );
    expect(store.getWorkItem(item.id)?.status).toBe("in_review");

    // The operator's coordinator chat may close for the operator, with the reason on the record.
    const closed = (await tool("update_work_item").handler(
      { id: item.id, status: "done", asOperator: true, note: "verified by the operator in chat" },
      ctxFor(operatorSource.id),
    )) as { workItem: { status: string } };
    expect(closed.workItem.status).toBe("done");
  });

  it("lets any employee report status but forbids backlog to done through an agent caller", async () => {
    const owner = registry.createSession({ engine: "codex", source: "web", sourceRef: "owner", title: "owner", employee: "platform-dev" });
    const other = registry.createSession({ engine: "codex", source: "web", sourceRef: "other", title: "other", employee: "other-dev" });

    const backlog = store.createWorkItem({ title: "No shortcut close", status: "backlog", assignee: "platform-dev", source: "session" });
    await expect(tool("update_work_item").handler({ id: backlog.id, status: "done" }, ctxFor(owner.id))).rejects.toThrow(
      /operator's decision.*in_review/i,
    );
    expect(store.getWorkItem(backlog.id)?.status).toBe("backlog");

    const unowned = store.createWorkItem({ title: "Assigned to someone else", status: "backlog", assignee: "platform-dev", source: "session" });
    const reported = (await tool("update_work_item").handler({ id: unowned.id, status: "blocked", note: "waiting" }, ctxFor(other.id))) as {
      workItem: { status: string };
    };
    expect(reported.workItem.status).toBe("blocked");

    const owned = store.createWorkItem({ title: "Owner may report blocked", status: "backlog", assignee: "platform-dev", source: "session" });
    const blocked = (await tool("update_work_item").handler({ id: owned.id, status: "blocked", note: "waiting on input" }, ctxFor(owner.id))) as {
      workItem: { status: string };
    };
    expect(blocked.workItem.status).toBe("blocked");
  });

  it("refuses archive to every agent session, while the operator's connector archives without deleting evidence", async () => {
    const owner = registry.createSession({ engine: "codex", source: "web", sourceRef: "archive-owner", title: "archive owner", employee: "platform-dev" });
    const outsider = registry.createSession({ engine: "codex", source: "web", sourceRef: "archive-outsider", title: "archive outsider", employee: "outsider" });
    const root = registry.createSession({ engine: "codex", source: "web", sourceRef: "archive-root", title: "archive root", employee: "coo" });
    const connector = registry.createSession({ engine: "codex", source: "remote-mcp", sourceRef: "remote-mcp:archive-op@example.com" });
    const item = store.createWorkItem({ title: "Archive, do not delete", status: "backlog", assignee: "platform-dev", source: "session" });

    // Archiving is the operator's: the Todo's owner and the portal/COO session are refused like anyone else.
    for (const session of [outsider, owner, root]) {
      await expect(tool("archive_work_item").handler({ id: item.id, note: "cancellation" }, ctxFor(session.id))).rejects.toThrow(
        /403.*operator's decision/i,
      );
    }
    expect(store.getWorkItem(item.id)).toMatchObject({ status: "backlog" });

    const archived = (await tool("archive_work_item").handler({ id: item.id, note: "obsolete" }, ctxFor(connector.id))) as {
      archived: boolean;
      workItem: { id: string; status: string; closedAt: string | null };
    };

    expect(archived.archived).toBe(true);
    expect(archived.workItem).toMatchObject({
      id: item.id,
      status: "cancelled",
    });
    expect(archived.workItem.closedAt).toBeTruthy();
    expect(store.getWorkItem(item.id)?.status).toBe("cancelled");
    const events = store.listWorkItemEvents(item.id);
    expect(events.some((e) => e.kind === "status_change" && e.fromStatus === "backlog" && e.toStatus === "cancelled")).toBe(true);
  });

  it("refuses retired fields and supplied provenance", async () => {
    const caller = registry.createSession({ engine: "codex", source: "web", sourceRef: "schema-caller", title: "schema caller" });
    const ctx = ctxFor(caller.id);

    await expect(tool("create_work_item").handler({ title: "Retired policy", verifyPolicy: { mode: "verify" } }, ctx)).rejects.toThrow(
      /verifyPolicy was removed from Todos/,
    );
    await expect(tool("create_work_item").handler({ title: "Unknown provenance key", provenance: { source: "session", extra: true } }, ctx)).rejects.toThrow(
      /provenance.*dedicated bridge|cannot be supplied/i,
    );
    await expect(tool("create_work_item").handler({ title: "Bad provenance source", provenance: { source: "bogus" } }, ctx)).rejects.toThrow(
      /provenance.*dedicated bridge|cannot be supplied/i,
    );
  });
});

describe("work-item comment tools (Todos v2 slice 2)", () => {
  it("comment_work_item posts to the comments route after local validation and caps the body at 64k chars", async () => {
    const { calls, ctx } = stub(() => ({ status: 201, body: { comment: { id: "wic_0a1b2c3d4e5f", body: "hello" } } }));
    const out = (await tool("comment_work_item").handler({ id: "JIN-7", body: "hello" }, ctx)) as Record<string, unknown>;
    expect(calls[0].method).toBe("POST");
    expect(new URL(calls[0].url).pathname).toBe("/api/work-items/JIN-7/comments");
    expect(calls[0].body).toEqual({ body: "hello" });
    expect((out.comment as Record<string, unknown>).id).toBe("wic_0a1b2c3d4e5f");
    expect(out.hint).toMatch(/get_work_item/);

    const threaded = stub(() => ({ status: 201, body: { comment: { id: "wic_ffffffffffff" } } }));
    await tool("comment_work_item").handler({ id: "JIN-7", body: "reply", parentCommentId: "wic_0a1b2c3d4e5f" }, threaded.ctx);
    expect(threaded.calls[0].body).toEqual({ body: "reply", parentCommentId: "wic_0a1b2c3d4e5f" });

    const silent = stub(() => ({ status: 500, body: { error: "must not run" } }));
    await expect(tool("comment_work_item").handler({ id: "JIN-7", body: "x".repeat(64_001) }, silent.ctx)).rejects.toThrow(/too long/);
    await expect(tool("comment_work_item").handler({ id: "JIN-7", body: "  " }, silent.ctx)).rejects.toThrow(/body/);
    await expect(tool("comment_work_item").handler({ id: "JIN-7", body: "x", parentCommentId: "not-a-comment" }, silent.ctx)).rejects.toThrow(/parentCommentId/);
    await expect(tool("comment_work_item").handler({ id: "nope", body: "x" }, silent.ctx)).rejects.toThrow(/canonical Todo ID/);
    expect(silent.calls).toEqual([]);
  });

  it("list_work_item_comments proxies the GET route with limit/offset", async () => {
    const { calls, ctx } = stub(() => ({ status: 200, body: { comments: [{ id: "wic_0a1b2c3d4e5f", body: "c1" }], total: 1, limit: 50, offset: 0 } }));
    const out = (await tool("list_work_item_comments").handler({ id: "JIN-7" }, ctx)) as Record<string, unknown>;
    expect(new URL(calls[0].url).pathname).toBe("/api/work-items/JIN-7/comments");
    expect(out.total).toBe(1);

    const paged = stub(() => ({ status: 200, body: { comments: [], total: 0, limit: 5, offset: 10 } }));
    await tool("list_work_item_comments").handler({ id: "JIN-7", limit: 5, offset: 10 }, paged.ctx);
    const url = new URL(paged.calls[0].url);
    expect(url.searchParams.get("limit")).toBe("5");
    expect(url.searchParams.get("offset")).toBe("10");
  });

  it("comment → get_work_item tail → full list round-trips through the real API", async () => {
    const commenter = registry.createSession({ engine: "codex", source: "web", sourceRef: "comment-roundtrip", title: "commenter", employee: "platform-dev" });
    const ctx = ctxFor(commenter.id);

    const item = store.createWorkItem({ title: "Comment round-trip" });
    const posted = (await tool("comment_work_item").handler({ id: item.id, body: "status update from MCP" }, ctx)) as {
      comment: { id: string; author: string; authorKind: string };
    };
    expect(posted.comment.author).toBe("platform-dev");
    expect(posted.comment.authorKind).toBe("employee");

    const reply = (await tool("comment_work_item").handler(
      { id: item.id, body: "threaded reply", parentCommentId: posted.comment.id },
      ctx,
    )) as { comment: { parentCommentId: string } };
    expect(reply.comment.parentCommentId).toBe(posted.comment.id);

    // get_work_item carries the tail via the route payload — no duplication needed.
    const detail = (await tool("get_work_item").handler({ id: item.id }, ctx)) as {
      comments: { total: number; comments: Array<{ body: string }> };
    };
    expect(detail.comments.total).toBe(2);
    expect(detail.comments.comments.map((c) => c.body)).toEqual(["status update from MCP", "threaded reply"]);

    const full = (await tool("list_work_item_comments").handler({ id: item.id, limit: 1, offset: 1 }, ctx)) as {
      comments: Array<{ body: string }>;
      total: number;
    };
    expect(full.total).toBe(2);
    expect(full.comments.map((c) => c.body)).toEqual(["threaded reply"]);
  });
});

describe("work-item relation + label tools (Todos v2 slice 3)", () => {
  it("link_work_items posts to the relations route after local validation", async () => {
    const { calls, ctx } = stub(() => ({ status: 201, body: { relation: { srcId: "JIN-1", dstId: "JIN-2", kind: "blocks" } } }));
    const out = (await tool("link_work_items").handler({ srcId: "JIN-1", dstId: "JIN-2", kind: "blocks" }, ctx)) as Record<string, unknown>;
    expect(calls[0].method).toBe("POST");
    expect(new URL(calls[0].url).pathname).toBe("/api/work-items/JIN-1/relations");
    expect(calls[0].body).toEqual({ dstId: "JIN-2", kind: "blocks" });
    expect((out.relation as Record<string, unknown>).kind).toBe("blocks");

    const silent = stub(() => ({ status: 500, body: { error: "must not run" } }));
    await expect(tool("link_work_items").handler({ srcId: "nope", dstId: "JIN-2", kind: "blocks" }, silent.ctx)).rejects.toThrow(/srcId/);
    await expect(tool("link_work_items").handler({ srcId: "JIN-1", dstId: "nope", kind: "blocks" }, silent.ctx)).rejects.toThrow(/dstId/);
    await expect(tool("link_work_items").handler({ srcId: "JIN-1", dstId: "JIN-2", kind: "meta" }, silent.ctx)).rejects.toThrow(/kind/);
    expect(silent.calls).toEqual([]);
  });

  it("unlink_work_items issues a DELETE with the same shape", async () => {
    const { calls, ctx } = stub(() => ({ status: 200, body: { removed: true } }));
    await tool("unlink_work_items").handler({ srcId: "JIN-1", dstId: "JIN-2", kind: "relates" }, ctx);
    expect(calls[0].method).toBe("DELETE");
    expect(new URL(calls[0].url).pathname).toBe("/api/work-items/JIN-1/relations");
    expect(calls[0].body).toEqual({ dstId: "JIN-2", kind: "relates" });
  });

  it("label_work_item validates the array locally and PUTs the label set", async () => {
    const { calls, ctx } = stub(() => ({ status: 200, body: { labels: [{ id: "lbl_0a1b2c3d4e5f", name: "bug" }] } }));
    await tool("label_work_item").handler({ id: "JIN-7", labels: [" bug "] }, ctx);
    expect(calls[0].method).toBe("PUT");
    expect(new URL(calls[0].url).pathname).toBe("/api/work-items/JIN-7/labels");
    expect(calls[0].body).toEqual({ labels: ["bug"] });

    const silent = stub(() => ({ status: 500, body: { error: "must not run" } }));
    await expect(tool("label_work_item").handler({ id: "JIN-7", labels: "bug" }, silent.ctx)).rejects.toThrow(/array/);
    await expect(tool("label_work_item").handler({ id: "JIN-7", labels: ["  "] }, silent.ctx)).rejects.toThrow(/array/);
    await expect(tool("label_work_item").handler({ id: "JIN-7", labels: Array.from({ length: 101 }, (_, i) => `l${i}`) }, silent.ctx)).rejects.toThrow(/100/);
    expect(silent.calls).toEqual([]);
  });

  it("edit_work_item validates locally: at least one field, priority 0..3, no status", async () => {
    const silent = stub(() => ({ status: 500, body: { error: "must not run" } }));
    await expect(tool("edit_work_item").handler({ id: "JIN-1" }, silent.ctx)).rejects.toThrow(/at least one/i);
    await expect(tool("edit_work_item").handler({ id: "JIN-1", priority: 9 }, silent.ctx)).rejects.toThrow(/priority/);
    await expect(tool("edit_work_item").handler({ id: "nope", body: "x" }, silent.ctx)).rejects.toThrow(/canonical Todo ID/);
    await expect(tool("edit_work_item").handler({ id: "JIN-1", body: "a".repeat(64_001) }, silent.ctx)).rejects.toThrow(/too long/);
    await expect(tool("edit_work_item").handler({ id: "JIN-1", title: "a".repeat(201) }, silent.ctx)).rejects.toThrow(/too long/);
    // Review F2: stray non-editable args refuse LOUDLY instead of silently
    // succeeding without the edit the agent asked for.
    await expect(tool("edit_work_item").handler({ id: "JIN-1", body: "x", assignee: "someone" }, silent.ctx)).rejects.toThrow(/assign_work_item/);
    await expect(tool("edit_work_item").handler({ id: "JIN-1", body: "x", department: "platform" }, silent.ctx)).rejects.toThrow(/operator/);
    await expect(tool("edit_work_item").handler({ id: "JIN-1", body: "x", rank: 3 }, silent.ctx)).rejects.toThrow(/operator/);
    expect(silent.calls).toEqual([]);
    const props = Object.keys(tool("edit_work_item").inputSchema.properties);
    expect(props.sort()).toEqual(["body", "dueAt", "id", "priority", "sprint", "title"]);
  });

  it("edit_work_item reads a fresh version and PATCHes with it", async () => {
    const { calls, ctx } = stub((call) => {
      if (call.method === "GET") return { status: 200, body: { workItem: { id: "JIN-9", version: 7 } } };
      return { status: 200, body: { workItem: { id: "JIN-9", version: 8, body: "edited" }, replayed: false } };
    });
    const out = (await tool("edit_work_item").handler({ id: "JIN-9", body: "edited", priority: 1 }, ctx)) as Record<string, unknown>;
    expect(calls.map((c) => c.method)).toEqual(["GET", "PATCH"]);
    expect(new URL(calls[1].url).pathname).toBe("/api/work-items/JIN-9");
    expect(calls[1].body).toEqual({ body: "edited", priority: 1, expectedVersion: 7 });
    expect((out.workItem as Record<string, unknown>).body).toBe("edited");
  });

  it("edit_work_item retries ONCE on a version conflict with a re-read version, then surfaces the second conflict", async () => {
    let version = 3;
    let patches = 0;
    const { calls, ctx } = stub((call) => {
      if (call.method === "GET") return { status: 200, body: { workItem: { id: "JIN-9", version } } };
      patches += 1;
      if (patches === 1) {
        version = 5; // concurrent bump between the read and the write
        return { status: 409, body: { error: "Todo changed since it was loaded.", code: "todo_version_conflict", currentVersion: 5 } };
      }
      return { status: 200, body: { workItem: { id: "JIN-9", version: 6 }, replayed: false } };
    });
    await tool("edit_work_item").handler({ id: "JIN-9", body: "retry me" }, ctx);
    expect(calls.map((c) => c.method)).toEqual(["GET", "PATCH", "GET", "PATCH"]);
    expect((calls[1].body as { expectedVersion: number }).expectedVersion).toBe(3);
    expect((calls[3].body as { expectedVersion: number }).expectedVersion).toBe(5);

    // a second consecutive conflict surfaces the route's 409
    const stubborn = stub((call) => {
      if (call.method === "GET") return { status: 200, body: { workItem: { id: "JIN-9", version: 1 } } };
      return { status: 409, body: { error: "Todo changed since it was loaded.", code: "todo_version_conflict", currentVersion: 2 } };
    });
    await expect(tool("edit_work_item").handler({ id: "JIN-9", body: "never lands" }, stubborn.ctx)).rejects.toThrow(/conflicted \(409\)/);
    expect(stubborn.calls.filter((c) => c.method === "PATCH")).toHaveLength(2);
  });

  it("edit_work_item surfaces the route's authority words verbatim", async () => {
    const { ctx } = stub((call) => {
      if (call.method === "GET") return { status: 200, body: { workItem: { id: "JIN-9", version: 1 } } };
      return { status: 403, body: { error: 'field "rank" is not editable by employee "platform-dev": assignee, department, rank are operator-only' } };
    });
    await expect(tool("edit_work_item").handler({ id: "JIN-9", body: "x" }, ctx)).rejects.toThrow(/refused \(403\).*"rank"/);
  });

  it("edit_work_item round-trips content edits through the real API, including the title", async () => {
    const dev = registry.createSession({ engine: "codex", source: "web", sourceRef: "slice4-editor", title: "editor", employee: "platform-dev" });
    const devCtx = ctxFor(dev.id);
    const item = store.createWorkItem({ title: "slice4 editable", assignee: "platform-dev" });

    const edited = (await tool("edit_work_item").handler(
      { id: item.id, title: "renamed over MCP", body: "refined over MCP", priority: 1, dueAt: "2026-08-20" },
      devCtx,
    )) as { workItem: Record<string, unknown> };
    expect(edited.workItem).toMatchObject({
      title: "renamed over MCP",
      body: "refined over MCP",
      priority: 1,
      dueAt: "2026-08-20T00:00:00.000Z",
    });
    const edit = store.listWorkItemEvents(item.id).filter((e) => e.kind === "metadata_edited").at(-1)!;
    expect(edit.actor).toBe("platform-dev");

    // …and a session that never touched the Todo edits its content just the same.
    const stranger = ctxFor(registry.createSession({ engine: "codex", source: "web", sourceRef: "slice4-stranger", title: "stranger" }).id);
    const byStranger = (await tool("edit_work_item").handler({ id: item.id, title: "renamed by a stranger" }, stranger)) as { workItem: Record<string, unknown> };
    expect(byStranger.workItem.title).toBe("renamed by a stranger");
  });

  it("link → label → list_labels → detail round-trips through the real API", async () => {
    // Label creation is manager-gated; platform-manager has a direct report.
    const manager = registry.createSession({ engine: "codex", source: "web", sourceRef: "slice3-mgr", title: "mgr", employee: "platform-manager" });
    const managerCtx = ctxFor(manager.id);
    const dev = registry.createSession({ engine: "codex", source: "web", sourceRef: "slice3-dev", title: "dev", employee: "platform-dev" });
    const devCtx = ctxFor(dev.id);

    const gate = store.createWorkItem({ title: "slice3 gate" });
    const waiting = store.createWorkItem({ title: "slice3 waiting", assignee: "platform-dev" });

    const linked = (await tool("link_work_items").handler({ srcId: gate.id, dstId: waiting.id, kind: "blocks" }, devCtx)) as {
      relation: { createdBy: string };
    };
    expect(linked.relation.createdBy).toBe(`session:${dev.id}`);
    await expect(
      tool("link_work_items").handler({ srcId: waiting.id, dstId: gate.id, kind: "blocks" }, devCtx),
    ).rejects.toThrow(/cycle/);

    // Label creation is route-gated: the IC session is refused, the manager
    // session (has a direct report) succeeds.
    const { gatewayRequest } = await import("../toolkit.js");
    const deniedCreate = await gatewayRequest(devCtx, "POST", "/api/labels", { name: "slice3-tag" });
    expect(deniedCreate.status).toBe(403);
    const managerCreate = await gatewayRequest(managerCtx, "POST", "/api/labels", { name: "slice3-tag" });
    expect(managerCreate.status).toBe(201);

    const labelled = (await tool("label_work_item").handler({ id: waiting.id, labels: ["slice3-tag"] }, devCtx)) as {
      labels: Array<{ name: string }>;
    };
    expect(labelled.labels.map((l) => l.name)).toEqual(["slice3-tag"]);
    await expect(tool("label_work_item").handler({ id: waiting.id, labels: ["ghost-label"] }, devCtx)).rejects.toThrow(/valid labels/);

    const listed = (await tool("list_labels").handler({}, devCtx)) as { labels: Array<{ name: string }> };
    expect(listed.labels.some((l) => l.name === "slice3-tag")).toBe(true);

    const detail = (await tool("get_work_item").handler({ id: waiting.id }, devCtx)) as {
      relations: Array<{ kind: string; direction: string; other: { id: string } }>;
      labels: Array<{ name: string }>;
    };
    expect(detail.relations).toHaveLength(1);
    expect(detail.relations[0]).toMatchObject({ kind: "blocks", direction: "in", other: { id: gate.id } });
    expect(detail.labels.map((l) => l.name)).toEqual(["slice3-tag"]);

    const filtered = (await tool("list_work_items").handler({ label: "slice3-tag" }, devCtx)) as {
      workItems: Array<{ id: string }>;
    };
    expect(filtered.workItems.map((w) => w.id)).toEqual([waiting.id]);

    const unlinked = (await tool("unlink_work_items").handler({ srcId: gate.id, dstId: waiting.id, kind: "blocks" }, devCtx)) as {
      removed: boolean;
    };
    expect(unlinked.removed).toBe(true);
  });

  it("create_label → create_work_item { labels } arms a Todo without leaving MCP", async () => {
    const manager = registry.createSession({ engine: "codex", source: "web", sourceRef: "mcp-lbl-mgr", title: "mgr", employee: "platform-manager" });
    const managerCtx = ctxFor(manager.id);
    const dev = registry.createSession({ engine: "codex", source: "web", sourceRef: "mcp-lbl-dev", title: "dev", employee: "platform-dev" });
    const devCtx = ctxFor(dev.id);

    // The route's manager gate reaches the caller verbatim rather than being swallowed.
    await expect(tool("create_label").handler({ name: "mcp-tag" }, devCtx)).rejects.toThrow(/refused \(403\).*manager/);

    const created = (await tool("create_label").handler({ name: "MCP Tag", color: "#22cc88" }, managerCtx)) as {
      label: { name: string; color: string };
    };
    expect(created.label).toMatchObject({ name: "mcp-tag", color: "#22cc88" });

    const tagged = (await tool("create_work_item").handler({ title: "armed at birth", labels: ["MCP Tag"] }, devCtx)) as {
      workItem: { id: string };
      labels: Array<{ name: string }>;
    };
    expect(tagged.labels.map((l) => l.name)).toEqual(["mcp-tag"]);
    const detail = (await tool("get_work_item").handler({ id: tagged.workItem.id }, devCtx)) as { labels: Array<{ name: string }> };
    expect(detail.labels.map((l) => l.name)).toEqual(["mcp-tag"]);

    // create_work_item never mints a label: an unknown name fails the create.
    await expect(tool("create_work_item").handler({ title: "never born", labels: ["ghost-tag"] }, devCtx)).rejects.toThrow(/valid labels/);
    const registryLabels = (await tool("list_labels").handler({}, devCtx)) as { labels: Array<{ name: string }> };
    expect(registryLabels.labels.map((l) => l.name)).not.toContain("ghost-tag");
    expect(store.listWorkItems({ text: "never born" })).toEqual([]);
  });
});

describe("work-item attachment + department tools (Todos v2 slice 5)", () => {
  it("attach_to_work_item uploads the session-host file as multipart after local validation", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "attach-unit-"));
    fs.writeFileSync(path.join(dir, "shot.png"), "png!");
    fs.writeFileSync(path.join(dir, "a.bin"), "abc");
    const { calls, ctx } = stub(() => ({ status: 201, body: { attachment: { id: "wia_0a1b2c3d4e5f", filename: "shot.png" } } }));
    const out = (await tool("attach_to_work_item").handler({ id: "JIN-7", path: path.join(dir, "shot.png") }, ctx)) as Record<string, unknown>;
    expect(calls[0].method).toBe("POST");
    expect(new URL(calls[0].url).pathname).toBe("/api/work-items/JIN-7/attachments");
    expect(calls[0].body).toEqual({ filename: "shot.png", file: "<shot.png:4>" });
    expect((out.attachment as Record<string, unknown>).id).toBe("wia_0a1b2c3d4e5f");

    const withMeta = stub(() => ({ status: 201, body: { attachment: { id: "wia_ffffffffffff" } } }));
    await tool("attach_to_work_item").handler(
      { id: "JIN-7", path: path.join(dir, "a.bin"), commentId: "wic_0a1b2c3d4e5f", filename: "renamed.bin" },
      withMeta.ctx,
    );
    expect(withMeta.calls[0].body).toEqual({ commentId: "wic_0a1b2c3d4e5f", filename: "renamed.bin", file: "<renamed.bin:3>" });

    const silent = stub(() => ({ status: 500, body: { error: "must not run" } }));
    await expect(tool("attach_to_work_item").handler({ id: "JIN-7", path: "  " }, silent.ctx)).rejects.toThrow(/path/);
    await expect(tool("attach_to_work_item").handler({ id: "JIN-7", path: "/x", commentId: "bogus" }, silent.ctx)).rejects.toThrow(/commentId/);
    await expect(tool("attach_to_work_item").handler({ id: "nope", path: "/x" }, silent.ctx)).rejects.toThrow(/canonical Todo ID/);
    await expect(tool("attach_to_work_item").handler({ id: "JIN-7", path: path.join(dir, "absent.png") }, silent.ctx)).rejects.toThrow(
      /file not found.*read on the host this session runs on/,
    );
    expect(silent.calls).toEqual([]);
  });

  it("list_work_item_attachments proxies the GET route", async () => {
    const { calls, ctx } = stub(() => ({ status: 200, body: { attachments: [{ id: "wia_0a1b2c3d4e5f", storagePath: "/inst/attachments/ab/abc" }] } }));
    const out = (await tool("list_work_item_attachments").handler({ id: "JIN-7" }, ctx)) as { attachments: Array<{ id: string }> };
    expect(calls[0].method).toBe("GET");
    expect(new URL(calls[0].url).pathname).toBe("/api/work-items/JIN-7/attachments");
    expect(out.attachments[0].id).toBe("wia_0a1b2c3d4e5f");
  });

  it("list_departments proxies the departments surface", async () => {
    const { calls, ctx } = stub(() => ({ status: 200, body: { departments: [{ slug: "platform", prefix: "PLA", todoCount: 3 }] } }));
    const out = (await tool("list_departments").handler({}, ctx)) as { departments: Array<{ slug: string }> };
    expect(calls[0].method).toBe("GET");
    expect(new URL(calls[0].url).pathname).toBe("/api/departments");
    expect(out.departments[0].slug).toBe("platform");
  });

  it("comment_work_item with attachments posts the comment, then uploads each file to it (max 10, validated locally)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comment-unit-"));
    for (const name of ["a.png", "b.png"]) fs.writeFileSync(path.join(dir, name), name);
    const { calls, ctx } = stub((call) =>
      call.url.includes("/comments")
        ? { status: 201, body: { comment: { id: "wic_0a1b2c3d4e5f", body: "with files" } } }
        : { status: 201, body: { attachment: { id: "wia_0a1b2c3d4e5f" } } },
    );
    const out = (await tool("comment_work_item").handler(
      { id: "JIN-7", body: "with files", attachments: [path.join(dir, "a.png"), path.join(dir, "b.png")] },
      ctx,
    )) as { comment: Record<string, unknown>; attachments: Array<Record<string, unknown>> };
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/api/work-items/JIN-7/comments",
      "/api/work-items/JIN-7/attachments",
      "/api/work-items/JIN-7/attachments",
    ]);
    expect(calls[1].body).toEqual({ commentId: "wic_0a1b2c3d4e5f", filename: "a.png", file: "<a.png:5>" });
    expect(calls[2].body).toEqual({ commentId: "wic_0a1b2c3d4e5f", filename: "b.png", file: "<b.png:5>" });
    expect(out.attachments).toHaveLength(2);

    const silent = stub(() => ({ status: 500, body: { error: "must not run" } }));
    await expect(
      tool("comment_work_item").handler({ id: "JIN-7", body: "x", attachments: Array.from({ length: 11 }, (_, i) => `/f/${i}`) }, silent.ctx),
    ).rejects.toThrow(/10/);
    await expect(
      tool("comment_work_item").handler({ id: "JIN-7", body: "x", attachments: ["  "] }, silent.ctx),
    ).rejects.toThrow(/attachments/);
    // Review B1: an unattachable file is refused BEFORE the comment is posted,
    // so a retry can never double-post it.
    const envFile = path.join(dir, ".env.local");
    fs.writeFileSync(envFile, "SECRET=1");
    await expect(
      tool("comment_work_item").handler({ id: "JIN-7", body: "x", attachments: [path.join(dir, "a.png"), envFile] }, silent.ctx),
    ).rejects.toThrow(/Refusing to read environment secret files/);
    expect(silent.calls).toEqual([]);
  });

  it("comment_work_item names the created comment when an upload fails after it was posted (review B1)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comment-after-"));
    const file = path.join(dir, "gone.txt");
    fs.writeFileSync(file, "here at vet time");
    const { calls, ctx } = stub((call) => {
      if (call.url.includes("/comments")) {
        fs.rmSync(file); // disappears between the vet and the upload
        return { status: 201, body: { comment: { id: "wic_0a1b2c3d4e5f" } } };
      }
      return { status: 500, body: { error: "must not run" } };
    });
    await expect(tool("comment_work_item").handler({ id: "JIN-7", body: "x", attachments: [file] }, ctx)).rejects.toThrow(
      /comment wic_0a1b2c3d4e5f was created, but attaching .* \(0\/1 uploaded\) failed: .*file not found.*do not re-post the comment/,
    );
    expect(calls).toHaveLength(1);
  });

  it("edit_work_item accepts explicit null to CLEAR dueAt (slice-4 review F3)", async () => {
    const { calls, ctx } = stub((call) =>
      call.method === "GET"
        ? { status: 200, body: { workItem: { id: "JIN-7", version: 4 } } }
        : { status: 200, body: { workItem: { id: "JIN-7", dueAt: null, version: 5 } } },
    );
    await tool("edit_work_item").handler({ id: "JIN-7", acceptance: null, dueAt: null }, ctx);
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.body).toEqual({ dueAt: null, expectedVersion: 4 });
  });

  it("attach → list → Read storagePath byte-compare, comment attachments, and the null-clear edit round-trip through the real API", async () => {
    const dev = registry.createSession({ engine: "codex", source: "web", sourceRef: "slice5-attacher", title: "attacher", employee: "platform-dev" });
    const ctx = ctxFor(dev.id);
    const item = store.createWorkItem({ title: "slice5 attachments", assignee: "platform-dev" });

    // The agent-consumption proof: attach a local file, list, then READ the
    // storagePath from disk and byte-compare to the source.
    const source = path.join(process.env.JINN_HOME!, "agent-screenshot.png");
    const sourceBytes = Buffer.from("pretend-png-bytes- ");
    fs.writeFileSync(source, sourceBytes);

    const attached = (await tool("attach_to_work_item").handler({ id: item.id, path: source }, ctx)) as {
      attachment: { id: string; filename: string; mime: string; uploadedBy: string; storagePath: string };
    };
    expect(attached.attachment.filename).toBe("agent-screenshot.png");
    expect(attached.attachment.mime).toBe("image/png");
    expect(attached.attachment.uploadedBy).toBe("platform-dev");

    const listed = (await tool("list_work_item_attachments").handler({ id: item.id }, ctx)) as {
      attachments: Array<{ id: string; storagePath: string; commentId: string | null }>;
    };
    expect(listed.attachments.map((a) => a.id)).toEqual([attached.attachment.id]);
    expect(fs.readFileSync(listed.attachments[0].storagePath)).toEqual(sourceBytes);

    // Comment-level: the tool creates the comment, then binds the file to it.
    const withFile = (await tool("comment_work_item").handler(
      { id: item.id, body: "see attached", attachments: [source] },
      ctx,
    )) as { comment: { id: string }; attachments: Array<{ commentId: string | null }> };
    expect(withFile.attachments).toHaveLength(1);
    expect(withFile.attachments[0].commentId).toBe(withFile.comment.id);

    // Null-clear round trip (F3): set, then clear, dueAt.
    await tool("edit_work_item").handler({ id: item.id, dueAt: "2026-09-01" }, ctx);
    expect(store.getWorkItem(item.id)).toMatchObject({ dueAt: "2026-09-01T00:00:00.000Z" });
    await tool("edit_work_item").handler({ id: item.id, dueAt: null }, ctx);
    expect(store.getWorkItem(item.id)).toMatchObject({ dueAt: null });

    // Departments surface reflects the registered department + count.
    store.createWorkItem({ title: "dept item", department: "platform" });
    const departments = (await tool("list_departments").handler({}, ctx)) as {
      departments: Array<{ slug: string; prefix: string; todoCount: number }>;
    };
    const platform = departments.departments.find((d) => d.slug === "platform");
    expect(platform).toBeDefined();
    expect(platform!.todoCount).toBeGreaterThanOrEqual(1);
  });
});

