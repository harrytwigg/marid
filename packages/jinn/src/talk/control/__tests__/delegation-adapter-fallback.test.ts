import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/** A Talk delegation is a child of the Talk session: it takes the session's fallback target only when that session passes its fallback on. */

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-talk-fallback-target-"));
process.env.JINN_HOME = home;

vi.mock("../../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../shared/models.js")>()),
  engineAvailable: () => true,
}));

let claimDelegation: typeof import("../delegation-adapter.js").claimTalkDelegation;
let sessions: typeof import("../../../sessions/registry.js");
let workItems: typeof import("../../../work-items/store.js");
let scope: typeof import("../../../work-items/department-scope.js");

const config = {
  gateway: {},
  engines: { default: "claude", claude: { bin: "claude", model: "opus" }, codex: { bin: "codex", model: "gpt-mini" } },
  models: {
    claude: { default: "opus", models: [{ id: "opus" }] },
    codex: { default: "gpt-mini", models: [{ id: "gpt-mini" }] },
  },
};
const target = { engine: "codex", model: "gpt-mini" };
let n = 0;

beforeAll(async () => {
  ({ claimTalkDelegation: claimDelegation } = await import("../delegation-adapter.js"));
  sessions = await import("../../../sessions/registry.js");
  workItems = await import("../../../work-items/store.js");
  scope = await import("../../../work-items/department-scope.js");
  (await import("../../../shared/db.js")).initDb();
});

afterEach(() => {
  scope.setDepartmentScopeResolver(null);
  scope.setEmployeeDepartmentResolver(null);
});

function delegate(parentMode: "fallback-children" | "fallback" | "auto-resume", employeeName = "a-worker", department?: string) {
  const parent = sessions.createSession({ engine: "codex", source: "talk", sourceRef: `talk:fallback-target-${n}`, fallbackMode: parentMode, fallbackTarget: target });
  const item = workItems.createWorkItem({ title: `Delegate with a target ${n}`, ...(department ? { department } : {}) });
  const call = { talkSessionId: `talk-ft-${n}`, providerCallId: `call-ft-${n}`, idempotencyKey: `talk:ft:${n++}`, caller: { kind: "operator", principal: "operator" } } as const;
  return claimDelegation({
    context: { getConfig: () => config } as unknown as Parameters<typeof claimDelegation>[0]["context"],
    sourceSessionId: parent.id,
    todoId: item.id,
    prompt: "Do the bounded thing.",
    employee: { name: employeeName, department: "platform", engine: "claude" },
    call,
  }).session;
}

describe("Talk delegation fallback inheritance", () => {
  it("a delegation from a fallback-children Talk session carries its target and mode", () => {
    expect(delegate("fallback-children")).toMatchObject({ fallbackMode: "fallback-children", fallbackTarget: target });
  });

  it.each(["fallback", "auto-resume"] as const)("one from a %s session gets auto-resume and no target", (mode) => {
    expect(delegate(mode)).toMatchObject({ fallbackMode: "auto-resume", fallbackTarget: null });
  });

  it("a department-scoped employee may not use an engine off claude, so it follows the chain instead", () => {
    scope.setDepartmentScopeResolver((department) => (department === "ops" ? "scoped" : "open"));
    scope.setEmployeeDepartmentResolver((name) => (name === "scoped-worker" ? "ops" : undefined));
    expect(delegate("fallback-children", "scoped-worker", "ops")).toMatchObject({ fallbackMode: "fallback-children", fallbackTarget: null });
  });
});

describe("Talk delegation board event", () => {
  it("records the link as a delegation, which is what todo.delegated hooks fire on", () => {
    const session = delegate("fallback-children");
    const linked = workItems.listWorkItemEvents(session.workItemId!).filter((event) => event.kind === "session_linked");
    expect(linked).toHaveLength(1);
    expect(linked[0].detail).toMatchObject({ sessionId: session.id, via: "delegation" });
  });
});
