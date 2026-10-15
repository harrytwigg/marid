import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-open-delegations-"));
process.env.JINN_HOME = tmp;

let store: typeof import("../store.js");
let delegations: typeof import("../open-delegations.js");
let detect: typeof import("../anomaly-detect.js");
let controller: typeof import("../recovery-controller.js");
let rows: typeof import("../recovery-rows.js");
let eventLog: typeof import("../event-log.js");
let transitions: typeof import("../transitions.js");
let db: import("better-sqlite3").Database;

beforeAll(async () => {
  store = await import("../store.js");
  delegations = await import("../open-delegations.js");
  detect = await import("../anomaly-detect.js");
  controller = await import("../recovery-controller.js");
  rows = await import("../recovery-rows.js");
  eventLog = await import("../event-log.js");
  transitions = await import("../transitions.js");
  db = (await import("../../shared/db.js")).initDb();
});

const HOUR = 60 * 60_000;
const later = (hours: number) => new Date(Date.now() + hours * HOUR);

function session(id: string, status: string, over: { workItemId?: string; parent?: string } = {}) {
  const at = new Date().toISOString();
  db.prepare(
    `INSERT INTO sessions (id, engine, source, source_ref, status, work_item_id, work_item_role, parent_session_id, created_at, last_activity)
     VALUES (?, 'claude', 'web', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, `web:${id}`, status, over.workItemId ?? null, over.workItemId ? "execute" : null, over.parent ?? null, at, at);
}

/** A parent Todo whose producer session ended its turn while it waits. */
function parentWaiting(name: string) {
  const parent = store.createWorkItem({ title: `${name} parent`, status: "executing", source: "session", assignee: "platform-worker" });
  session(`${name}-parent`, "idle", { workItemId: parent.id });
  db.prepare("UPDATE sessions SET attempt_outcome = 'succeeded' WHERE id = ?").run(`${name}-parent`);
  return { parent, sessionId: `${name}-parent` };
}

function child(parentId: string, status: "executing" | "in_review" | "done" | "cancelled" | "blocked" | "backlog") {
  return store.createWorkItem({ title: `child ${status}`, status, source: "session", assignee: "platform-worker", parentId });
}

const sweep = (now: Date) => controller.sweepTodoRecovery({ mode: "classify-only", now: () => now, rearm: () => ({ status: "assigned" }) });

describe("open delegations", () => {
  it.each(["executing", "backlog", "blocked"] as const)("a %s sub-task keeps its parent waiting", (status) => {
    const { parent, sessionId } = parentWaiting(`sub-${status}`);
    child(parent.id, status);
    expect(delegations.hasOpenSubTasks(parent.id)).toBe(true);
    expect(delegations.sessionHasOpenDelegations({ id: sessionId, workItemId: parent.id })).toBe(true);
    expect(delegations.todoHasOpenDelegations(parent.id)).toBe(true);
  });

  it.each(["in_review", "done", "cancelled"] as const)("a %s sub-task no longer does", (status) => {
    const { parent, sessionId } = parentWaiting(`closed-${status}`);
    child(parent.id, status);
    expect(delegations.sessionHasOpenDelegations({ id: sessionId, workItemId: parent.id })).toBe(false);
    expect(delegations.todoHasOpenDelegations(parent.id)).toBe(false);
  });

  it("a session it started that is running does, and stops once it is idle", () => {
    const { parent, sessionId } = parentWaiting("qa");
    session("qa-reviewer", "running", { parent: sessionId });
    expect(delegations.sessionHasOpenDelegations({ id: sessionId, workItemId: parent.id })).toBe(true);
    expect(delegations.todoHasOpenDelegations(parent.id)).toBe(true);
    db.prepare("UPDATE sessions SET status = 'idle' WHERE id = ?").run("qa-reviewer");
    expect(delegations.sessionHasOpenDelegations({ id: sessionId, workItemId: parent.id })).toBe(false);
    expect(delegations.todoHasOpenDelegations(parent.id)).toBe(false);
  });

  it("a session with no Todo is only waiting on sessions it started", () => {
    session("loose", "idle");
    expect(delegations.sessionHasOpenDelegations({ id: "loose", workItemId: null })).toBe(false);
    session("loose-child", "waiting", { parent: "loose" });
    expect(delegations.sessionHasOpenDelegations({ id: "loose", workItemId: null })).toBe(true);
  });
});

describe("a parent that stays executing while its children work", () => {
  it("raises no recovery or attention event across several sweeps, even past the 4h budget", () => {
    const { parent } = parentWaiting("quiet");
    child(parent.id, "executing");
    child(parent.id, "in_review");
    for (const hours of [1, 5, 24, 48]) {
      const now = later(hours);
      expect(detect.detectTodoAnomalies({ now, persist: false }).find((row) => row.workItemId === parent.id)).toBeUndefined();
      sweep(now);
      expect(rows.getWorkItemRecovery(parent.id)?.lane).not.toBe("manager");
    }
    expect(store.getWorkItem(parent.id)?.status).toBe("executing");
    expect(store.listWorkItems({ needsAttentionFor: "operator" }).map((row) => row.id)).not.toContain(parent.id);
    const events = eventLog.listWorkItemEvents(parent.id);
    expect(events.length).toBeGreaterThan(0);
    expect(events.map((event) => event.kind)).not.toContain("escalated");
  });

  it("is flagged as before once the children are all handed in and it has gone quiet", () => {
    const { parent } = parentWaiting("handed");
    const kid = child(parent.id, "executing");
    expect(detect.detectTodoAnomalies({ now: later(48), persist: false }).find((row) => row.workItemId === parent.id)).toBeUndefined();
    transitions.transition(kid.id, "in_review", "platform-worker");
    expect(detect.detectTodoAnomalies({ now: later(48), persist: false }).find((row) => row.workItemId === parent.id))
      .toMatchObject({ kind: "executing-unhanded", lane: "manager" });
  });
});
