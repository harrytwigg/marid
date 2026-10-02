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
    delegation.recordLandedBrief({ briefKey: "b1", workItemId: item.id, employee: "alpha", sessionId: "s1", delegatorSessionId: "delegator" });
    delegation.startBriefTurn("s1", ["b1"]);
    expect(records.getEmployeeSessionRecord(item.id, "alpha")?.delegatorSessionId).toBe("delegator");

    expect(records.swapEmployeeSession(item.id, "alpha", "s1", "s2")).toBe(true);
    expect(records.getEmployeeSessionRecord(item.id, "alpha")).toMatchObject({ sessionId: "s2", delegatorSessionId: null, delegatedAt: null });
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

  it("reports to a landed brief's delegator only once that brief's turn starts", () => {
    const item = store.createWorkItem({ title: "who hears back" });
    const session = { ...linked(item.id, "alpha"), parentSessionId: "first-parent" };
    records.swapEmployeeSession(item.id, "alpha", records.getEmployeeSessionRecord(item.id, "alpha")?.sessionId ?? null, session.id);
    expect(delegation.reportingParentSessionId(session)).toBe("first-parent");

    delegation.recordLandedBrief({ briefKey: "brief-2", workItemId: item.id, employee: "alpha", sessionId: session.id, delegatorSessionId: "second" });
    expect(delegation.startBriefTurn(session.id, ["queue:other-turn"])).toBeUndefined();
    expect(delegation.reportingParentSessionId(session)).toBe("first-parent");

    expect(delegation.startBriefTurn(session.id, ["queue:x", "brief-2"])?.delegatorSessionId).toBe("second");
    expect(delegation.withReportingParent(session).parentSessionId).toBe("second");
    expect(delegation.startBriefTurn(session.id, ["brief-2"])).toBeUndefined();

    delegation.recordLandedBrief({ briefKey: "brief-3", workItemId: item.id, employee: "alpha", sessionId: session.id, delegatorSessionId: null });
    delegation.startBriefTurn(session.id, ["brief-3"]);
    expect(delegation.reportingParentSessionId(session)).toBeNull();
  });

  it("never names a session, or a loop back to it, as its reporting parent", () => {
    const item = store.createWorkItem({ title: "loops" });
    const a = linked(item.id, "alpha");
    const b = linked(item.id, "bravo");
    records.swapEmployeeSession(item.id, "alpha", null, a.id);
    records.swapEmployeeSession(item.id, "bravo", null, b.id);
    delegation.recordNewDelegateSession(item.id, "alpha", a.id, b.id);
    delegation.recordNewDelegateSession(item.id, "bravo", b.id, a.id);

    expect(delegation.reportsUpTo(b.id, a.id)).toBe(true);
    expect(delegation.reportingParentSessionId({ ...a, parentSessionId: "a-parent" })).toBe("a-parent");
    expect(delegation.reportingParentSessionId({ ...b, parentSessionId: b.id })).toBeNull();
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
