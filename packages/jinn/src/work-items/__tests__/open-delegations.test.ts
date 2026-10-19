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
let db: import("better-sqlite3").Database;

beforeAll(async () => {
  store = await import("../store.js");
  delegations = await import("../open-delegations.js");
  detect = await import("../anomaly-detect.js");
  controller = await import("../recovery-controller.js");
  rows = await import("../recovery-rows.js");
  eventLog = await import("../event-log.js");
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
  const open = (parentId: string, sessionId: string, now = Date.now()) =>
    delegations.hasOpenDelegations(parentId, [{ id: sessionId }], now);

  it("an executing sub-task keeps its parent waiting", () => {
    const { parent, sessionId } = parentWaiting("sub-executing");
    child(parent.id, "executing");
    expect(open(parent.id, sessionId)).toBe(true);
  });

  // None of these will wake the parent: nothing starts a backlog child, a
  // blocked one waits on a person, a handed-in one on the operator.
  it.each(["backlog", "blocked", "in_review", "done", "cancelled"] as const)("a %s sub-task does not", (status) => {
    const { parent, sessionId } = parentWaiting(`not-waiting-${status}`);
    child(parent.id, status);
    expect(open(parent.id, sessionId)).toBe(false);
  });

  it("a session it started that is running does, and stops once it is idle", () => {
    const { parent, sessionId } = parentWaiting("qa");
    session("qa-reviewer", "running", { parent: sessionId });
    expect(open(parent.id, sessionId)).toBe(true);
    db.prepare("UPDATE sessions SET status = 'idle' WHERE id = ?").run("qa-reviewer");
    expect(open(parent.id, sessionId)).toBe(false);
  });

  it("a child session still marked running long after it last spoke is stale, not working", () => {
    const { parent, sessionId } = parentWaiting("stale");
    session("stale-reviewer", "running", { parent: sessionId });
    expect(open(parent.id, sessionId, later(1).getTime())).toBe(true);
    expect(open(parent.id, sessionId, later(5).getTime())).toBe(false);
  });

  it("only sessions started by the Todo's own attempts count", () => {
    const { parent } = parentWaiting("own");
    const other = parentWaiting("someone-else");
    session("someone-elses-reviewer", "running", { parent: other.sessionId });
    expect(open(parent.id, "own-parent")).toBe(false);
  });
});

describe("a parent that stays executing while its children work", () => {
  const flagged = (id: string, now: Date) => detect.detectTodoAnomalies({ now, persist: false }).find((row) => row.workItemId === id);

  it("raises no recovery or attention event across several sweeps, even past the 4h budget", () => {
    const { parent } = parentWaiting("quiet");
    child(parent.id, "executing");
    child(parent.id, "in_review");
    for (const hours of [1, 5, 24, 48]) {
      const now = later(hours);
      expect(flagged(parent.id, now)).toBeUndefined();
      sweep(now);
      expect(rows.getWorkItemRecovery(parent.id)?.lane).not.toBe("manager");
    }
    expect(store.getWorkItem(parent.id)?.status).toBe("executing");
    expect(store.listWorkItems({ needsAttentionFor: "operator" }).map((row) => row.id)).not.toContain(parent.id);
    const events = eventLog.listWorkItemEvents(parent.id);
    expect(events.length).toBeGreaterThan(0);
    expect(events.map((event) => event.kind)).not.toContain("escalated");
  });

  it("is not flagged while a reviewer session it started is running", () => {
    const { parent, sessionId } = parentWaiting("reviewing");
    session("reviewing-qa", "running", { parent: sessionId });
    const now = later(3);
    db.prepare("UPDATE sessions SET last_activity = ? WHERE id = 'reviewing-qa'").run(now.toISOString());
    expect(flagged(parent.id, later(5))).toBeUndefined();
  });

  it.each(["in_review", "blocked", "backlog"] as const)("is flagged as before once its children are %s and it has gone quiet", (status) => {
    const { parent } = parentWaiting(`settled-${status}`);
    const kid = child(parent.id, "executing");
    expect(flagged(parent.id, later(48))).toBeUndefined();
    db.prepare("UPDATE work_items SET status = ? WHERE id = ?").run(status, kid.id);
    expect(flagged(parent.id, later(48))).toMatchObject({ kind: "executing-unhanded", lane: "manager" });
  });
});
