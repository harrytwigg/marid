import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Throwaway registry (SESSIONS_DB resolves from JINN_HOME at module load).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-park-expiry-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type Transitions = typeof import("../transitions.js");
type StopCause = typeof import("../stop-cause.js");
type ParkExpiry = typeof import("../park-expiry.js");
type Reconcile = typeof import("../reconcile.js");

let store: Store;
let tr: Transitions;
let sc: StopCause;
let parks: ParkExpiry;
let reconcile: Reconcile;
let db: import("better-sqlite3").Database;

beforeAll(async () => {
  store = await import("../store.js");
  tr = await import("../transitions.js");
  sc = await import("../stop-cause.js");
  parks = await import("../park-expiry.js");
  reconcile = await import("../reconcile.js");
  db = (await import("../../shared/db.js")).initDb();
});

const AGENT = "session:agent-1";
const DAY = 86_400_000;
const hint = { what: "run the 30-day check", who: "whoever picks it up" };

const inDays = (days: number): string => new Date(Date.now() + days * DAY).toISOString();
const justAfter = (iso: string): Date => new Date(Date.parse(iso) + 1_000);

const mk = (status: "backlog" | "executing", extra: Record<string, unknown> = {}) =>
  store.createWorkItem({ title: `t-${Math.random().toString(36).slice(2, 8)}`, status, ...extra });

/** Park the way the docs now say to: a plain block carrying `parkedUntil`. */
function park(id: string, parkedUntil: string, extra: Partial<import("../stop-cause.js").TodoStopCause> = {}): void {
  tr.transition(id, "blocked", AGENT, { agent: true, stopCause: { parkedUntil, ...extra }, detail: { note: "date-gated" } });
}

const cause = (id: string) => sc.readStopCause(db, id);
const rawParkedUntil = (id: string) =>
  (db.prepare("SELECT parked_until FROM work_item_stop_cause WHERE work_item_id = ?").get(id) as { parked_until: string | null } | undefined)
    ?.parked_until;

function linkedSession(id: string, workItemId: string, status: string, at: string, outcome: string | null): void {
  db.prepare(
    `INSERT INTO sessions (id, engine, source, source_ref, status, attempt_outcome, work_item_id, created_at, last_activity)
     VALUES (?, 'claude', 'cron', ?, ?, ?, ?, ?, ?)`,
  ).run(id, `cron:${id}`, status, outcome, workItemId, at, at);
}

describe("releaseExpiredParks — a park ends on its own", () => {
  it("leaves a park alone until its date, then puts an unowned Todo back in backlog", () => {
    const item = mk("backlog");
    const until = inDays(9);
    park(item.id, until);
    expect(store.getWorkItem(item.id)?.status).toBe("blocked");

    expect(parks.releaseExpiredParks(new Date(Date.parse(until) - 1_000))).toBe(0);
    expect(store.getWorkItem(item.id)?.status).toBe("blocked");
    expect(cause(item.id)?.parkedUntil).toBe(until);

    // Advance past the date: the Todo resumes without anybody touching it.
    expect(parks.releaseExpiredParks(justAfter(until))).toBeGreaterThanOrEqual(1);
    expect(store.getWorkItem(item.id)?.status).toBe("backlog");
    // Leaving `blocked` takes the park with it, so the next tick has nothing to do.
    expect(rawParkedUntil(item.id)).toBeUndefined();

    const resumed = store.listWorkItemEvents(item.id).at(-1);
    expect(resumed).toMatchObject({ kind: "status_change", fromStatus: "blocked", toStatus: "backlog", actor: "park-expiry" });
    expect(resumed?.detail).toMatchObject({ reason: "park-expired", parkedUntil: until });
  });

  it("re-queues an owned Todo to backlog with its assignee, as a dependency block would", () => {
    const item = mk("backlog", { assignee: "junior-developer" });
    const until = inDays(2);
    park(item.id, until);

    parks.releaseExpiredParks(justAfter(until));
    expect(store.getWorkItem(item.id)).toMatchObject({ status: "backlog", assignee: "junior-developer" });
  });

  it("releases each park once — a second sweep over the same clock moves nothing", () => {
    const item = mk("backlog");
    const until = inDays(3);
    park(item.id, until);
    const later = justAfter(until);

    parks.releaseExpiredParks(later);
    const moves = store.listWorkItemEvents(item.id).length;
    parks.releaseExpiredParks(later);
    expect(store.listWorkItemEvents(item.id)).toHaveLength(moves);
    expect(store.getWorkItem(item.id)?.status).toBe("backlog");
  });

  it("does not touch a block waiting on a human, with or without a hint", () => {
    const plain = mk("executing");
    tr.transition(plain.id, "blocked", AGENT, { agent: true, detail: { note: "need the API key" } });
    const hinted = mk("executing");
    tr.transition(hinted.id, "blocked", AGENT, { agent: true, stopCause: { unblockHint: hint }, detail: { note: "need a decision" } });

    parks.releaseExpiredParks(new Date(Date.now() + 365 * DAY));
    expect(store.getWorkItem(plain.id)?.status).toBe("blocked");
    expect(store.getWorkItem(hinted.id)?.status).toBe("blocked");
    expect(cause(hinted.id)).toEqual({ unblockHint: hint });
  });

  it("counts toward the block-loop breaker like any block: the third park of an unfinished Todo escalates into blocked", () => {
    const item = mk("backlog");
    for (const round of [1, 2]) {
      const until = inDays(round);
      park(item.id, until);
      expect(store.getWorkItem(item.id)?.status).toBe("blocked");
      parks.releaseExpiredParks(justAfter(until));
      expect(store.getWorkItem(item.id)?.status).toBe("backlog");
    }
    const third = inDays(3);
    park(item.id, third);
    expect(store.getWorkItem(item.id)?.status).toBe("blocked");
    expect(store.listWorkItemEvents(item.id).at(-1)).toMatchObject({ kind: "escalated", toStatus: "blocked" });

    // The escalation waits on the operator, not the clock: its date does not release it.
    parks.releaseExpiredParks(justAfter(third));
    expect(store.getWorkItem(item.id)?.status).toBe("blocked");
  });

  it("runs on the reconciler's periodic tick, so a park ends without a restart", async () => {
    const item = mk("backlog");
    park(item.id, new Date(Date.now() - 60_000).toISOString());

    const stop = reconcile.startWorkItemReconciler(20);
    await new Promise((resolve) => setTimeout(resolve, 80));
    stop();

    expect(store.getWorkItem(item.id)?.status).toBe("backlog");
    expect(store.listWorkItemEvents(item.id).at(-1)).toMatchObject({ fromStatus: "blocked", toStatus: "backlog", actor: "park-expiry" });
  });

  it("runs on the reconciler's boot pass, so a park that ran out while the gateway was down still ends", () => {
    const item = mk("backlog");
    // Already in the past by the time the gateway comes back.
    park(item.id, new Date(Date.now() - 60_000).toISOString());

    reconcile.reconcileWorkItemsOnStartup();
    expect(store.getWorkItem(item.id)?.status).toBe("backlog");
  });
});

describe("a released park is a decision the old attempts cannot overrule", () => {
  it("stays in backlog when the attempt before the park had succeeded (not pulled into in_review)", () => {
    const item = mk("executing");
    linkedSession("s-before-park-ok", item.id, "idle", new Date(Date.now() - DAY).toISOString(), "succeeded");
    const until = new Date(Date.now() - 1_000).toISOString();
    park(item.id, until);

    parks.releaseExpiredParks();
    expect(store.getWorkItem(item.id)?.status).toBe("backlog");
    expect(reconcile.reconcileWorkItem(item.id)).toMatchObject({ changed: false, item: { status: "backlog" } });
    expect(reconcile.reconcileWorkItem(item.id)).toMatchObject({ changed: false, item: { status: "backlog" } });
  });

  it("is not re-blocked by an attempt that failed before the park", () => {
    const item = mk("executing");
    linkedSession("s-before-park-failed", item.id, "idle", new Date(Date.now() - DAY).toISOString(), "failed");
    park(item.id, new Date(Date.now() - 1_000).toISOString());

    parks.releaseExpiredParks();
    expect(reconcile.reconcileWorkItem(item.id)).toMatchObject({ changed: false, item: { status: "backlog" } });
  });

  it("derives executing again once a new attempt runs after the release (the floor self-clears)", () => {
    const item = mk("executing");
    linkedSession("s-before-park", item.id, "idle", new Date(Date.now() - DAY).toISOString(), "succeeded");
    park(item.id, new Date(Date.now() - 1_000).toISOString());
    parks.releaseExpiredParks();

    linkedSession("s-after-release", item.id, "running", new Date(Date.now() + 60_000).toISOString(), null);
    expect(reconcile.reconcileWorkItem(item.id)).toMatchObject({ changed: true, item: { status: "executing" } });
  });
});

describe("re-parking a Todo that is already parked", () => {
  it("moves the date instead of silently keeping the old one, and keeps the hint it did not restate", () => {
    const item = mk("backlog");
    const first = inDays(2);
    park(item.id, first, { unblockHint: hint });
    const version = store.getWorkItem(item.id)!.version;

    const later = inDays(9);
    const result = tr.transition(item.id, "blocked", AGENT, { agent: true, stopCause: { parkedUntil: later }, detail: { note: "pushed out a week" } });
    expect(result.item.status).toBe("blocked");
    expect(result.item.version).toBeGreaterThan(version);
    expect(cause(item.id)).toEqual({ parkedUntil: later, unblockHint: hint });

    const note = store.listWorkItemEvents(item.id).at(-1);
    expect(note).toMatchObject({ kind: "note", fromStatus: null, toStatus: "blocked", actor: AGENT });
    expect(note?.detail).toMatchObject({ note: "pushed out a week", parkedUntil: later });

    // The first date no longer releases it; the new one does.
    parks.releaseExpiredParks(justAfter(first));
    expect(store.getWorkItem(item.id)?.status).toBe("blocked");
    parks.releaseExpiredParks(justAfter(later));
    expect(store.getWorkItem(item.id)?.status).toBe("backlog");
  });

  it("no-ops a re-park that restates the cause the Todo already carries — no note, no version bump", () => {
    const item = mk("backlog");
    const until = inDays(4);
    park(item.id, until, { unblockHint: hint });
    const before = store.getWorkItem(item.id)!;
    const events = store.listWorkItemEvents(item.id).length;

    const result = tr.transition(item.id, "blocked", AGENT, { agent: true, stopCause: { parkedUntil: until }, detail: { note: "same again" } });
    expect(result.event).toBeUndefined();
    expect(store.getWorkItem(item.id)?.version).toBe(before.version);
    expect(store.listWorkItemEvents(item.id)).toHaveLength(events);
  });

  it("still no-ops a same-status block that restates nothing", () => {
    const item = mk("executing");
    tr.transition(item.id, "blocked", AGENT, { agent: true, detail: { note: "stuck" } });
    const before = store.getWorkItem(item.id)!;

    const result = tr.transition(item.id, "blocked", AGENT, { agent: true, detail: { note: "still stuck" } });
    expect(result.event).toBeUndefined();
    expect(store.getWorkItem(item.id)?.version).toBe(before.version);
  });
});
