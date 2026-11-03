import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Point the registry DB at a throwaway dir BEFORE importing it (SESSIONS_DB is
// resolved from JINN_HOME at module load). Keeps the suite off the live DB.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-restart-replay-"));
process.env.JINN_HOME = tmp;

const gatewayConfig: { resumeInterruptedSessions?: boolean } = {};
vi.mock("../../shared/config.js", () => ({
  loadConfig: vi.fn(() => ({ gateway: gatewayConfig })),
}));

type Store = typeof import("../store.js");
type Runs = typeof import("../runs.js");
type Reconcile = typeof import("../reconcile.js");
type Registry = typeof import("../../sessions/registry.js");
type Settles = typeof import("../child-settles.js");
type RestartResume = typeof import("../../sessions/restart-resume.js");

let store: Store;
let runs: Runs;
let reconcile: Reconcile;
let registry: Registry;
let settles: Settles;
let restartResume: RestartResume;
let db: import("better-sqlite3").Database;

const OLD_GATEWAY = { bootId: "old00001", gatewayVersion: "0.0.0-test" };
const NEW_GATEWAY = { bootId: "new00002", gatewayVersion: "0.0.0-test" };
const T0 = Date.parse("2026-11-03T09:00:00.000Z");
/** How long past its due time a planned nudge still holds the Todo (RESTART_RESUME_DUE_GRACE_MS). */
const GRACE_MS = 2 * 60_000;

beforeAll(async () => {
  store = await import("../store.js");
  runs = await import("../runs.js");
  reconcile = await import("../reconcile.js");
  registry = await import("../../sessions/registry.js");
  settles = await import("../child-settles.js");
  restartResume = await import("../../sessions/restart-resume.js");
  db = (await import("../../shared/db.js")).initDb();
});

beforeEach(() => {
  // The nudges' timers never fire here: what is under test is the window
  // before a resumed turn starts, and the tests start it by hand.
  vi.useFakeTimers({ now: T0 });
  delete gatewayConfig.resumeInterruptedSessions;
  // One restart at a time: earlier tests' sessions must not be resumed again.
  db.prepare("UPDATE sessions SET status = 'idle', attempt_outcome = 'succeeded', transport_meta = NULL").run();
  db.prepare("UPDATE queue_items SET status = 'completed'").run();
});

afterEach(() => {
  vi.useRealTimers();
});

/** A child Todo under an `executing` parent, delegated to a session that is
 *  mid-turn when the gateway goes down: the session row is `running`, its run is
 *  open, and the turn it is running sits in the queue as `running`. */
function childMidTurn(tag: string, opts: { source?: string; queued?: boolean } = {}) {
  const parent = store.createWorkItem({ title: `parent ${tag}`, status: "executing", source: "delegation" });
  const child = store.createWorkItem({ title: `child ${tag}`, status: "executing", source: "delegation", parentId: parent.id });
  const sessionId = `s-${tag}`;
  db.prepare(
    `INSERT INTO sessions (id, engine, source, source_ref, session_key, status, work_item_id, created_at, last_activity)
     VALUES (?, 'claude', ?, ?, ?, 'running', ?, '2026-11-03T08:59:00.000Z', '2026-11-03T08:59:00.000Z')`,
  ).run(sessionId, opts.source ?? "web", `delegation:${child.id}:${sessionId}`, `web:${sessionId}`, child.id);
  const run = runs.openWorkItemRun({ workItemId: child.id, sessionId });
  let queueItemId: string | undefined;
  if (opts.queued !== false) {
    queueItemId = registry.enqueueQueueItem(sessionId, `web:${sessionId}`, "do the child's work");
    registry.markQueueItemRunning(queueItemId);
  }
  return { parent, child, sessionId, runId: run.id, queueItemId };
}

/** The boot, in `server.ts` order, up to and including the restart nudge plan.
 *  The queue replay is reduced to the state write it makes before dispatching
 *  (`resumePendingQueueItem`): web sessions with a pending row go `running`. */
function boot(): void {
  registry.recoverStaleSessions();
  registry.recoverStaleQueueItems();
  // Deferred to setImmediate, so it runs while the boot awaits the attach gate:
  // before the restart requesters are acknowledged and the queue is replayed.
  reconcile.reconcileWorkItemsOnStartup();
  restartResume.acknowledgeRestartRequesters(NEW_GATEWAY);
  for (const item of registry.listAllPendingQueueItems()) {
    const session = registry.getSession(item.sessionId);
    if (session?.source === "web") registry.updateSession(session.id, { status: "running" });
  }
  restartResume.resumeRestartInterruptedSessions(NEW_GATEWAY);
}

/** One tick of the periodic reconciler. */
function sweep(): void {
  reconcile.reconcileActiveWorkItems();
  runs.closeRunsForSettledSessions();
}

/** The resumed turn starts: a new attempt. */
function resumedTurnStarts(sessionId: string): void {
  registry.beginSessionAttempt(sessionId);
}

/** The resumed turn starts, then finishes cleanly. */
function resumedTurnSucceeds(sessionId: string): void {
  resumedTurnStarts(sessionId);
  sweep();
  db.prepare("UPDATE queue_items SET status = 'completed' WHERE session_id = ?").run(sessionId);
  registry.updateSession(sessionId, { status: "idle", attemptOutcome: "succeeded" });
  sweep();
}

function statusEvents(id: string): string[] {
  return (db.prepare("SELECT to_status FROM work_item_events WHERE work_item_id = ? AND kind = 'status_change' ORDER BY created_at, rowid")
    .all(id) as { to_status: string }[]).map((row) => row.to_status);
}

function expectNoFlap(t: ReturnType<typeof childMidTurn>, eventsBefore: string[]): void {
  expect(store.getWorkItem(t.child.id)?.status).toBe("executing");
  expect(statusEvents(t.child.id)).toEqual(eventsBefore);
  expect(settles.pendingChildSettles(t.parent.id)).toEqual([]);
}

function expectBlocked(t: ReturnType<typeof childMidTurn>): void {
  expect(store.getWorkItem(t.child.id)?.status).toBe("blocked");
  expect(settles.pendingChildSettles(t.parent.id)).toMatchObject([{ childId: t.child.id, toStatus: "blocked" }]);
  expect(runs.listWorkItemRuns(t.child.id)).toMatchObject([{ id: t.runId, outcome: "abandoned" }]);
}

describe("a hard restart mid-turn on a child Todo whose turn the queue replay picks up", () => {
  it("keeps the child executing, writes no child-settle, and leaves the run open until the real settle", () => {
    const t = childMidTurn("replayed");
    const before = statusEvents(t.child.id);

    registry.recoverStaleSessions();
    registry.recoverStaleQueueItems();
    reconcile.reconcileWorkItemsOnStartup();
    // The periodic sweep may tick before the replay starts: it must agree.
    sweep();
    expectNoFlap(t, before);
    expect(runs.listWorkItemRuns(t.child.id)).toMatchObject([{ id: t.runId, endedAt: null, outcome: null }]);

    boot();
    resumedTurnSucceeds(t.sessionId);

    expectNoFlap(t, before);
    expect(runs.listWorkItemRuns(t.child.id)).toMatchObject([{ id: t.runId, outcome: "completed" }]);
  });
});

describe("a restart mid-turn on a child Todo the restart nudge resumes", () => {
  it("keeps the child executing through a graceful shutdown, the boot and the stagger, until the nudge lands", () => {
    const t = childMidTurn("graceful");
    const before = statusEvents(t.child.id);

    restartResume.interruptRunningSessionsForShutdown(OLD_GATEWAY);
    // The killed turn completes its queue row on the way down, so the boot has
    // nothing to replay and resumes it with a nudge instead.
    db.prepare("UPDATE queue_items SET status = 'completed' WHERE id = ?").run(t.queueItemId);
    sweep();
    boot();
    vi.setSystemTime(T0 + GRACE_MS - 1_000);
    sweep();

    expectNoFlap(t, before);
    expect(runs.listWorkItemRuns(t.child.id)).toMatchObject([{ id: t.runId, endedAt: null }]);

    resumedTurnSucceeds(t.sessionId);
    expectNoFlap(t, before);
    expect(runs.listWorkItemRuns(t.child.id)).toMatchObject([{ id: t.runId, outcome: "completed" }]);
  });

  it("keeps the child executing when its session asked for the restart itself", () => {
    const t = childMidTurn("requester");
    const before = statusEvents(t.child.id);
    registry.updateSession(t.sessionId, { transportMeta: { restartAcknowledgedAt: new Date(T0 - 10_000).toISOString() } });

    restartResume.interruptRunningSessionsForShutdown(OLD_GATEWAY);
    db.prepare("UPDATE queue_items SET status = 'completed' WHERE id = ?").run(t.queueItemId);
    sweep();
    boot();
    sweep();

    expectNoFlap(t, before);
    expect(runs.listWorkItemRuns(t.child.id)).toMatchObject([{ id: t.runId, endedAt: null }]);
    resumedTurnSucceeds(t.sessionId);
    expectNoFlap(t, before);
  });

  it("derives blocked when the resumed turn is then stopped, inside the nudge's grace", () => {
    const t = childMidTurn("stopped-after-resume", { queued: false });

    boot();
    vi.setSystemTime(T0 + 5_000);
    resumedTurnStarts(t.sessionId);
    sweep();
    expect(store.getWorkItem(t.child.id)?.status).toBe("executing");
    vi.setSystemTime(T0 + 20_000);
    registry.updateSession(t.sessionId, { status: "interrupted", lastError: "Interrupted: stopped" });
    sweep();

    expectBlocked(t);
  });

  it("derives blocked when the interrupted turn is reset before its nudge is due", () => {
    const t = childMidTurn("reset-before-nudge", { queued: false });

    boot();
    sweep();
    expect(store.getWorkItem(t.child.id)?.status).toBe("executing");
    registry.updateSession(t.sessionId, { status: "interrupted", lastError: "Interrupted: session reset" });
    sweep();

    expectBlocked(t);
  });

  it("covers a nudge further down the stagger for as long as it is due", () => {
    const first = childMidTurn("stagger-1", { queued: false });
    const second = childMidTurn("stagger-2", { queued: false });
    const before = statusEvents(second.child.id);

    boot();
    // The second nudge is due one stagger step after the first.
    vi.setSystemTime(T0 + restartResume.RESTART_RESUME_STAGGER_MS + GRACE_MS - 1_000);
    sweep();

    expectNoFlap(second, before);
    expectBlocked(first);
  });

  it("derives blocked once a nudge that never landed is past its grace", () => {
    const t = childMidTurn("nudge-lost", { queued: false });

    boot();
    sweep();
    expect(store.getWorkItem(t.child.id)?.status).toBe("executing");
    vi.setSystemTime(T0 + GRACE_MS + 1_000);
    sweep();

    expectBlocked(t);
  });
});

describe("a restart mid-turn on a child Todo nothing resumes", () => {
  it("derives blocked on the first sweep after the boot when the restart nudges are off", () => {
    gatewayConfig.resumeInterruptedSessions = false;
    const t = childMidTurn("nudges-off", { queued: false });

    boot();
    sweep();

    expectBlocked(t);
  });

  it("derives blocked for a connector session, whose queue row the boot neither replays nor nudges", () => {
    const t = childMidTurn("connector", { source: "telegram" });

    boot();
    sweep();

    expectBlocked(t);
  });

  it("derives blocked for a turn the operator stopped with a row still queued, which no restart marked", () => {
    const t = childMidTurn("operator-stop", { queued: false });
    registry.enqueueQueueItem(t.sessionId, `web:${t.sessionId}`, "a follow-up");
    registry.updateSession(t.sessionId, { status: "interrupted", lastError: "Interrupted: stopped" });

    sweep();

    expectBlocked(t);
  });
});
