import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Throwaway registry (SESSIONS_DB resolves from JINN_HOME at module load).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-transitions-agent-lane-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type Transitions = typeof import("../transitions.js");

let store: Store;
let tr: Transitions;

beforeAll(async () => {
  store = await import("../store.js");
  tr = await import("../transitions.js");
});

const mk = (status: Store["createWorkItem"] extends (i: infer I) => unknown ? (I extends { status?: infer S } ? S : never) : never, extra: Partial<Parameters<Store["createWorkItem"]>[0]> = {}) =>
  store.createWorkItem({ title: `t-${Math.random().toString(36).slice(2, 8)}`, status, ...extra });

describe("transition — manual start and the agent lane", () => {
  it("allows an operator to manually start backlog work, assigned or not", () => {
    for (const extra of [{}, { assignee: "ana" }]) {
      const wi = mk("backlog", extra);
      const { item } = tr.transition(wi.id, "executing", "operator", { human: true, manual: true });

      expect(item.status).toBe("executing");
      expect(store.listWorkItemEvents(wi.id).at(-1)).toMatchObject({
        kind: "status_change",
        fromStatus: "backlog",
        toStatus: "executing",
        actor: "operator",
      });
    }
  });

  it.each(["done", "cancelled", "blocked"] as const)("rejects a manual start from %s", (status) => {
    const wi = mk(status);

    expect(() => tr.transition(wi.id, "executing", "operator", { human: true, manual: true })).toThrowError(
      new RegExp(`illegal manual transition ${status} → executing`),
    );
    expect(store.getWorkItem(wi.id)?.status).toBe(status);
  });

  it.each([
    ["blocked", "executing"],
    ["in_review", "executing"],
    ["executing", "backlog"],
  ] as const)("lets the agent lane walk %s → %s, along a declared edge", (from, to) => {
    const wi = mk(from);

    expect(tr.transition(wi.id, to, "session:agent-1", { manual: true, agent: true }).item.status).toBe(to);
  });

  // The operator sending work back from review is the review bounce: rounds
  // go up, and the last round allowed stops the Todo for the operator.
  it("treats the operator's in_review → executing as a review bounce", () => {
    const wi = mk("in_review");

    const sent = tr.transition(wi.id, "executing", "operator", { human: true, manual: true, detail: { note: "tighten the tests" } });
    expect([sent.item.status, sent.item.rounds, sent.escalated]).toEqual(["executing", 1, false]);
    expect(store.listWorkItemEvents(wi.id).at(-1)).toMatchObject({ fromStatus: "in_review", toStatus: "executing", detail: { bounce: true, rounds: 1 } });

    tr.transition(wi.id, "in_review", "session:agent-1", { manual: true, agent: true });
    const again = tr.transition(wi.id, "executing", "operator", { human: true, manual: true });
    expect([again.item.status, again.item.rounds, again.escalated]).toEqual(["executing", 2, false]);
  });

  it("does not count the agent taking its own work back out of review as a round", () => {
    const wi = mk("in_review");

    expect(tr.transition(wi.id, "executing", "session:agent-1", { manual: true, agent: true }).item.rounds).toBe(0);
  });

  it("applies the edge map to the agent lane too: opts.agent skips only the manual-start rule", () => {
    // in_review → backlog is no declared edge, and `agent` does not widen the map.
    const wi = mk("in_review");

    expect(() => tr.transition(wi.id, "backlog", "session:agent-1", { manual: true, agent: true })).toThrowError(
      /illegal transition in_review → backlog/,
    );
    expect(store.getWorkItem(wi.id)?.status).toBe("in_review");
  });

  it("refuses a manual start from blocked unless the caller is the agent lane", () => {
    const wi = mk("blocked");

    expect(() => tr.transition(wi.id, "executing", "operator", { human: true, manual: true })).toThrowError(
      /illegal manual transition blocked → executing/,
    );
    expect(tr.transition(wi.id, "executing", "session:agent-1", { manual: true, agent: true }).item.status).toBe("executing");
  });

  it.each(["done", "cancelled"] as const)("still refuses the agent lane an exit from %s", (status) => {
    const wi = mk(status);

    expect(() => tr.transition(wi.id, "executing", "session:agent-1", { manual: true, agent: true })).toThrowError(
      /leaving a sticky terminal is a human decision/,
    );
    expect(store.getWorkItem(wi.id)?.status).toBe(status);
  });

  it.each(["in_review", "done", "blocked"] as const)("keeps manual executing → %s legal", (status) => {
    const wi = mk("backlog");
    tr.transition(wi.id, "executing", "operator", { human: true, manual: true });

    expect(tr.transition(wi.id, status, "operator", { human: true, manual: true }).item.status).toBe(status);
  });
});
