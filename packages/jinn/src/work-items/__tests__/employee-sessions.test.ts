import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-employee-sessions-"));
process.env.JINN_HOME = home;

let records: typeof import("../employee-sessions.js");
let delegation: typeof import("../employee-session-delegation.js");
let registry: typeof import("../../sessions/registry.js");
let store: typeof import("../store.js");

beforeAll(async () => {
  records = await import("../employee-sessions.js");
  delegation = await import("../employee-session-delegation.js");
  registry = await import("../../sessions/registry.js");
  store = await import("../store.js");
});

function linked(todoId: string, employee: string) {
  const session = registry.createSession({ engine: "codex", source: "web", sourceRef: `t:${crypto.randomUUID()}`, employee, connector: "web" });
  store.linkSession(todoId, session.id);
  return registry.getSession(session.id)!;
}

describe("the (Todo, employee) record", () => {
  it("takes the row only from the holder it expects", () => {
    const item = store.createWorkItem({ title: "cas" });
    expect(records.swapEmployeeSession(item.id, "alpha", null, "s1")).toBe(true);
    expect(records.swapEmployeeSession(item.id, "alpha", null, "s2")).toBe(false);
    expect(records.swapEmployeeSession(item.id, "alpha", "s0", "s2")).toBe(false);
    delegation.recordDelegation(item.id, "alpha", { id: "s1", attemptToken: null }, "delegator", { immediate: true });

    expect(records.swapEmployeeSession(item.id, "alpha", "s1", "s2")).toBe(true);
    expect(records.getEmployeeSessionRecord(item.id, "alpha")).toMatchObject({ sessionId: "s2", delegatorSessionId: null, delegatedAt: null, pendingDelegatedAt: null });
  });

  it("adopts a live linked session it has no row for, and passes over dead and reset ones", () => {
    const item = store.createWorkItem({ title: "adopt" });
    const errored = linked(item.id, "alpha");
    registry.updateSession(errored.id, { status: "error" });
    const reset = linked(item.id, "alpha");
    registry.updateSession(reset.id, { sessionKey: `archived:${reset.id}`, status: "idle" });
    expect(records.liveEmployeeSession(item.id, "alpha")).toBeUndefined();

    const live = linked(item.id, "alpha");
    registry.updateSession(live.id, { status: "interrupted" });

    expect(records.liveEmployeeSession(item.id, "alpha")?.id).toBe(live.id);
    expect(records.getEmployeeSessionRecord(item.id, "alpha")?.sessionId).toBe(live.id);
  });

  it("rolls the whole start back when the spawn throws", () => {
    const item = store.createWorkItem({ title: "rollback" });
    const before = registry.listSessionsByWorkItem(item.id).length;

    expect(() => records.resolveEmployeeSession(item.id, "bravo", () => {
      linked(item.id, "bravo");
      throw new Error("engine went away");
    })).toThrow("engine went away");

    expect(registry.listSessionsByWorkItem(item.id)).toHaveLength(before);
    expect(records.getEmployeeSessionRecord(item.id, "bravo")).toBeUndefined();
  });

  it("refuses a start whose row moved under it, leaving the winner in place", () => {
    const item = store.createWorkItem({ title: "lost the race" });
    expect(() => records.resolveEmployeeSession(item.id, "bravo", () => {
      const session = linked(item.id, "bravo");
      registry.updateSession(session.id, { status: "error" });
      records.swapEmployeeSession(item.id, "bravo", null, "winner");
      return session;
    })).toThrow(/changed while a new one was being started/);
  });

  it("reports to a landed delegator from the session's next turn, to nobody for the operator, else to the parent", () => {
    const item = store.createWorkItem({ title: "who hears back" });
    const live = registry.updateSession(linked(item.id, "alpha").id, { attemptToken: "turn-1" })!;
    const session = { ...live, parentSessionId: "first-parent" };
    records.swapEmployeeSession(item.id, "alpha", records.getEmployeeSessionRecord(item.id, "alpha")?.sessionId ?? null, session.id);
    expect(delegation.reportingParentSessionId(session)).toBe("first-parent");

    delegation.recordDelegation(item.id, "alpha", session, "second");
    expect(delegation.reportingParentSessionId(session)).toBe("first-parent");
    expect(delegation.withReportingParent({ ...session, attemptToken: "turn-2" }).parentSessionId).toBe("second");

    // A third lands on turn 2: the second has taken over, and the third waits for turn 3.
    delegation.recordDelegation(item.id, "alpha", { ...session, attemptToken: "turn-2" }, null);
    expect(delegation.reportingParentSessionId({ ...session, attemptToken: "turn-2" })).toBe("second");
    expect(delegation.reportingParentSessionId({ ...session, attemptToken: "turn-3" })).toBeNull();
  });

  it("never names a session as its own reporting parent", () => {
    const item = store.createWorkItem({ title: "self" });
    const session = registry.updateSession(linked(item.id, "alpha").id, { attemptToken: "t1" })!;
    records.swapEmployeeSession(item.id, "alpha", records.getEmployeeSessionRecord(item.id, "alpha")?.sessionId ?? null, session.id);
    delegation.recordDelegation(item.id, "alpha", session, session.id, { immediate: true });

    expect(delegation.reportingParentSessionId({ ...session, parentSessionId: "parent" })).toBe("parent");
    expect(delegation.reportingParentSessionId({ ...session, parentSessionId: session.id })).toBeNull();
  });

  it("prefers the employee's working session over a consultation it recorded earlier", () => {
    const item = store.createWorkItem({ title: "stale consult" });
    const consult = linked(item.id, "alpha");
    store.linkSession(item.id, consult.id, null, "consult");
    registry.updateSession(consult.id, { status: "idle" });
    records.swapEmployeeSession(item.id, "alpha", null, consult.id);
    const working = linked(item.id, "alpha");

    expect(records.liveEmployeeSession(item.id, "alpha")?.id).toBe(working.id);
    expect(records.getEmployeeSessionRecord(item.id, "alpha")?.sessionId).toBe(working.id);
  });
});
