import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-executing-unhanded-"));
process.env.JINN_HOME = tmp;

let store: typeof import("../store.js");
let runs: typeof import("../runs.js");
let reconcile: typeof import("../reconcile.js");
let detect: typeof import("../anomaly-detect.js");
let controller: typeof import("../recovery-controller.js");
let rows: typeof import("../recovery-rows.js");
let transitions: typeof import("../transitions.js");
let db: import("better-sqlite3").Database;

beforeAll(async () => {
  store = await import("../store.js");
  runs = await import("../runs.js");
  reconcile = await import("../reconcile.js");
  detect = await import("../anomaly-detect.js");
  controller = await import("../recovery-controller.js");
  rows = await import("../recovery-rows.js");
  transitions = await import("../transitions.js");
  db = (await import("../../shared/db.js")).initDb();
});

const HOUR = 60 * 60_000;
const later = (hours: number) => new Date(Date.now() + hours * HOUR);

/** QA's repro: a producer whose run settled cleanly without handing.
 *  The reconciler leaves it `executing` and the settle closes its run. */
function abandonedMidWork(title: string): string {
  const item = store.createWorkItem({ title, status: "executing", source: "session", assignee: "platform-worker" });
  const sessionId = `s-${item.id}`;
  const at = new Date().toISOString();
  db.prepare(
    `INSERT INTO sessions (id, engine, source, source_ref, status, work_item_id, created_at, last_activity)
     VALUES (?, 'claude', 'web', ?, 'running', ?, ?, ?)`,
  ).run(sessionId, `web:${sessionId}`, item.id, at, at);
  runs.openWorkItemRun({ workItemId: item.id, sessionId, startedAt: at });
  db.prepare("UPDATE sessions SET status = 'idle', attempt_outcome = 'succeeded' WHERE id = ?").run(sessionId);
  reconcile.reconcileActiveWorkItems();
  return item.id;
}

const sweep = (now: Date) => controller.sweepTodoRecovery({ mode: "classify-only", now: () => now, rearm: () => ({ status: "assigned" }) });
const unhanded = (id: string, now: Date) =>
  detect.detectTodoAnomalies({ now, persist: false }).find((row) => row.workItemId === id);

describe("a Todo left executing after its producer stopped", () => {
  it("reaches Manager attention once its last attempt has been quiet past the 4h budget", () => {
    const id = abandonedMidWork("never handed in");
    expect(store.getWorkItem(id)?.status).toBe("executing");
    expect(runs.listWorkItemRuns(id).every((run) => run.endedAt !== null)).toBe(true);

    const now = later(48);
    expect(unhanded(id, now)).toMatchObject({ kind: "executing-unhanded", lane: "manager" });
    sweep(now);
    expect(rows.getWorkItemRecovery(id)).toMatchObject({ lane: "manager", class: "operator" });
    expect(store.listWorkItems({ needsAttentionFor: "operator" }).map((row) => row.id)).toContain(id);
  });

  it("is not flagged inside the budget — a producer waiting on QA is not a stall", () => {
    const id = abandonedMidWork("waiting on QA");
    const now = later(1);
    expect(unhanded(id, now)).toBeUndefined();
    sweep(now);
    expect(rows.getWorkItemRecovery(id)?.lane).not.toBe("manager");
  });

  it("is not flagged while a linked execution session is live again, even with its run closed", () => {
    const id = abandonedMidWork("producer resumed");
    db.prepare("UPDATE sessions SET status = 'running', attempt_outcome = NULL WHERE id = ?").run(`s-${id}`);
    expect(unhanded(id, later(48))).toBeUndefined();
  });

  // QA round 2: the clock also starts at the move into executing, so a Todo
  // re-entering it after a long quiet gets its own budget.
  it("gives a review bounce its own 4h, however long ago the producer last spoke", () => {
    const id = abandonedMidWork("bounced back");
    db.prepare("UPDATE sessions SET last_activity = ? WHERE id = ?").run(new Date(Date.now() - 5 * HOUR).toISOString(), `s-${id}`);
    transitions.transition(id, "in_review", "platform-worker");
    transitions.transition(id, "executing", "operator");
    expect(store.getWorkItem(id)?.status).toBe("executing");

    expect(unhanded(id, new Date())).toBeUndefined();
    expect(unhanded(id, later(1))).toBeUndefined();
    sweep(later(1));
    expect(rows.getWorkItemRecovery(id)?.lane).not.toBe("manager");
    expect(unhanded(id, later(5))).toMatchObject({ kind: "executing-unhanded", lane: "manager" });
  });

  it("gives an operator re-open its own 4h too", () => {
    const id = abandonedMidWork("re-opened by hand");
    db.prepare("UPDATE sessions SET last_activity = ? WHERE id = ?").run(new Date(Date.now() - 30 * HOUR).toISOString(), `s-${id}`);
    transitions.transition(id, "blocked", "operator");
    transitions.transition(id, "executing", "operator");

    expect(unhanded(id, later(1))).toBeUndefined();
    expect(unhanded(id, later(5))).toMatchObject({ kind: "executing-unhanded" });
  });

  it("is not flagged once the producer hands it in", () => {
    const id = abandonedMidWork("handed in");
    transitions.transition(id, "in_review", "platform-worker");
    expect(unhanded(id, later(48))).toBeUndefined();
  });
});
