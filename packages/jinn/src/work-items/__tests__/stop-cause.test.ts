import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import {
  isParked,
  parseParkedUntil,
  parseUnblockHint,
  UNBLOCK_HINT_ERROR,
} from "../stop-cause.js";

// Throwaway registry (SESSIONS_DB resolves from JINN_HOME at module load).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-stop-cause-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type Transitions = typeof import("../transitions.js");
type StopCause = typeof import("../stop-cause.js");
type RecoveryRows = typeof import("../recovery-rows.js");

let store: Store;
let tr: Transitions;
let sc: StopCause;
let recoveryRows: RecoveryRows;
let db: import("better-sqlite3").Database;

beforeAll(async () => {
  store = await import("../store.js");
  tr = await import("../transitions.js");
  sc = await import("../stop-cause.js");
  recoveryRows = await import("../recovery-rows.js");
  db = (await import("../../shared/db.js")).initDb();
});

const mk = (status: "backlog" | "executing", extra: Record<string, unknown> = {}) =>
  store.createWorkItem({ title: `t-${Math.random().toString(36).slice(2, 8)}`, status, ...extra });

const AGENT = "session:agent-1";
const HOUR = 3_600_000;
const hint = { what: "sign the renewal", who: "the operator" };

describe("the unblock hint validator", () => {
  it("accepts a hint and trims both halves", () => {
    expect(parseUnblockHint({ what: "  sign it ", who: " the operator " })).toEqual({ what: "sign it", who: "the operator" });
  });

  it("says nothing when the caller said nothing", () => {
    expect(parseUnblockHint(undefined)).toBeUndefined();
  });

  it.each([
    ["an unknown key", { what: "a", who: "b", when: "later" }],
    ["only what", { what: "a" }],
    ["only who", { who: "b" }],
    ["an empty what", { what: "", who: "b" }],
    ["a whitespace who", { what: "a", who: "  " }],
    ["a non-string half", { what: "a", who: 7 }],
    ["a bare string", "a — b"],
    ["an array", [{ what: "a", who: "b" }]],
    ["null", null],
  ])("refuses %s", (_label, value) => {
    expect(parseUnblockHint(value)).toBeNull();
  });

  it("names both halves and the closed key set in the one message every surface uses", () => {
    expect(UNBLOCK_HINT_ERROR).toMatch(/what/);
    expect(UNBLOCK_HINT_ERROR).toMatch(/who/);
    expect(UNBLOCK_HINT_ERROR).toMatch(/no other keys/);
  });
});

describe("the parkedUntil validator", () => {
  it("normalizes a readable timestamp", () => {
    expect(parseParkedUntil("2026-08-21T09:00:00Z")).toBe("2026-08-21T09:00:00.000Z");
  });

  it.each([["a phrase", "when the quota resets"], ["a number", 1_700_000_000], ["an object", {}]])(
    "refuses %s",
    (_label, value) => expect(parseParkedUntil(value)).toBeNull(),
  );
});

describe("a park expires by the clock, not by a sweep", () => {
  const now = Date.parse("2026-08-21T12:00:00.000Z");

  it("is a park only while it is still ahead", () => {
    expect(isParked("2026-08-21T12:00:01.000Z", now)).toBe(true);
    expect(isParked("2026-08-21T11:59:59.000Z", now)).toBe(false);
    expect(isParked("2026-08-21T12:00:00.000Z", now)).toBe(false);
  });

  it.each([["one that will not parse", "soon"], ["an empty string", ""], ["null", null], ["undefined", undefined]])(
    "reads %s as not parked, because fail-open is the only safe direction",
    (_label, value) => expect(isParked(value, now)).toBe(false),
  );

  it("drops a park that has passed on the way out of the database", () => {
    const item = mk("executing");
    tr.transition(item.id, "blocked", AGENT, { agent: true, stopCause: { parkedUntil: new Date(Date.now() - HOUR).toISOString() } });
    expect(sc.readStopCause(db, item.id)).toBeUndefined();
  });

  it("drops a park that will not parse, even though nothing honest could have written it", () => {
    const item = mk("executing");
    tr.transition(item.id, "blocked", AGENT, { agent: true, stopCause: { parkedUntil: new Date(Date.now() + HOUR).toISOString() } });
    db.prepare("UPDATE work_item_stop_cause SET parked_until = 'whenever' WHERE work_item_id = ?").run(item.id);
    expect(sc.readStopCause(db, item.id)).toBeUndefined();
  });
});

describe("the cause belongs to the stop", () => {
  it("is stored with the status that made it true", () => {
    const item = mk("executing");
    const parkedUntil = new Date(Date.now() + HOUR).toISOString();
    tr.transition(item.id, "blocked", AGENT, { agent: true, stopCause: { parkedUntil, unblockHint: hint } });
    expect(sc.readStopCause(db, item.id)).toEqual({ parkedUntil, unblockHint: hint });
  });

  // `backlog` matters as much as the rest: it is what keeps a parked Todo out of
  // the board walk's starts, which take only `backlog` Todos.
  it.each(["executing", "in_review", "done", "backlog"] as const)("is gone once the Todo moves to %s", (to) => {
    const item = mk("executing");
    tr.transition(item.id, "blocked", AGENT, { agent: true, stopCause: { unblockHint: hint } });
    expect(sc.readStopCause(db, item.id)).toEqual({ unblockHint: hint });

    tr.transition(item.id, to, AGENT, { agent: true });
    expect(sc.readStopCause(db, item.id)).toBeUndefined();
  });

  it("goes with the Todo when the Todo goes", () => {
    const item = mk("executing");
    tr.transition(item.id, "blocked", AGENT, { agent: true, stopCause: { unblockHint: hint } });
    db.prepare("DELETE FROM work_items WHERE id = ?").run(item.id);
    expect(db.prepare("SELECT 1 FROM work_item_stop_cause WHERE work_item_id = ?").get(item.id)).toBeUndefined();
  });
});

describe("the needs-attention set counts people, not clocks", () => {
  const queue = (assignee: string) => store.queryWorkItems({ needsAttentionFor: assignee }).workItems.map((i) => i.id);

  it("leaves out a Todo whose park has not run out, and keeps one whose park has", () => {
    const owner = `owner-${Math.random().toString(36).slice(2, 8)}`;
    const parked = mk("executing", { assignee: owner });
    const expired = mk("executing", { assignee: owner });
    const plain = mk("executing", { assignee: owner });

    tr.transition(parked.id, "blocked", AGENT, { agent: true, stopCause: { parkedUntil: new Date(Date.now() + HOUR).toISOString() } });
    tr.transition(expired.id, "blocked", AGENT, { agent: true, stopCause: { parkedUntil: new Date(Date.now() + HOUR).toISOString() } });
    db.prepare("UPDATE work_item_stop_cause SET parked_until = ? WHERE work_item_id = ?")
      .run(new Date(Date.now() - HOUR).toISOString(), expired.id);
    tr.transition(plain.id, "blocked", AGENT, { agent: true, stopCause: { unblockHint: hint } });

    const ids = queue(owner);
    expect(ids).toContain(expired.id);
    expect(ids).toContain(plain.id);
    expect(ids).not.toContain(parked.id);
  });

  it("keeps a parked Todo that recovery has routed to a manager — the routed lane outranks the park", () => {
    const owner = `owner-${Math.random().toString(36).slice(2, 8)}`;
    const item = mk("executing", { assignee: owner });
    recoveryRows.upsertWorkItemRecovery({
      workItemId: item.id, incidentId: "incident-1", class: "operator", lane: "manager", reason: "routed to a manager",
    });
    expect(queue(owner)).toContain(item.id);

    tr.transition(item.id, "blocked", AGENT, { agent: true, stopCause: { parkedUntil: new Date(Date.now() + HOUR).toISOString() } });
    expect(queue(owner)).toContain(item.id);
  });

  it("keeps a Todo whose park will not parse — a field that hides work must fail open", () => {
    const owner = `owner-${Math.random().toString(36).slice(2, 8)}`;
    const item = mk("executing", { assignee: owner });
    tr.transition(item.id, "blocked", AGENT, { agent: true, stopCause: { parkedUntil: new Date(Date.now() + HOUR).toISOString() } });
    expect(queue(owner)).not.toContain(item.id);

    db.prepare("UPDATE work_item_stop_cause SET parked_until = 'whenever' WHERE work_item_id = ?").run(item.id);
    expect(queue(owner)).toContain(item.id);
  });
});
