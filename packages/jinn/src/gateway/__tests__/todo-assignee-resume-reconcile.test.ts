import { describe, expect, it } from "vitest";
import { api, ctx, makeReq, makeRes, reg, store, toolHeaders } from "./helpers/work-items-route-harness.js";
import { listWorkItemEvents } from "../../work-items/event-log.js";
import { reconcileWorkItem } from "../../work-items/reconcile.js";

/* The assignee's own move to `executing` through the status route, when the
 * session making it cannot be linked as the Todo's executor (it is already
 * executing another open Todo), must survive the reconciler: the only attempt
 * the Todo has is an older run that ended badly, and deriving from that receipt
 * would put the Todo straight back to `blocked`. */

async function call(method: string, path: string, body: unknown, headers: Record<string, string>) {
  const cap = makeRes();
  await api.handleApiRequest(makeReq(method, path, body, headers), cap.res, ctx);
  return cap;
}

let n = 0;
const past = (ms: number) => new Date(Date.now() - ms).toISOString();

/** A blocked Todo for `assignee` whose only execution attempt, a dispatcher run, was interrupted. */
function blockedByFailedRun(assignee: string): string {
  const item = store.createWorkItem({ title: `Interrupted ${++n}`, status: "executing", assignee });
  const run = reg.createSession({ engine: "codex", source: "web", sourceRef: `web:failed-run-${n}`, employee: "todo-dispatcher", prompt: "work" });
  store.linkSession(item.id, run.id, null, "execute");
  reg.updateSession(run.id, { status: "interrupted", attemptOutcome: "interrupted", lastActivity: past(60_000) });
  expect(reconcileWorkItem(item.id)?.item.status).toBe("blocked");
  return item.id;
}

/** A session of `employee` that is running on a different open Todo, so the status route cannot relink it. */
function busyElsewhere(employee: string): string {
  const session = reg.createSession({ engine: "codex", source: "web", sourceRef: `web:busy-${++n}`, employee, prompt: "work" });
  const other = store.createWorkItem({ title: `Busy ${n}`, status: "executing", assignee: employee });
  store.linkSession(other.id, session.id, null, "execute");
  reg.updateSession(session.id, { status: "running", lastActivity: new Date().toISOString() });
  return session.id;
}

const statusesAcrossSweeps = (id: string, sweeps = 3) =>
  Array.from({ length: sweeps }, () => reconcileWorkItem(id)?.item.status);

describe("the assignee resuming a blocked Todo from a session busy on another Todo", () => {
  it("stays executing across reconcile passes instead of being re-blocked by the older failed run", async () => {
    const id = blockedByFailedRun("solo-worker");
    const sessionId = busyElsewhere("solo-worker");

    const moved = await call("POST", `/api/work-items/${id}/status`, { status: "executing" }, toolHeaders(sessionId));
    expect([moved.status, moved.body.workItem.status]).toEqual([200, "executing"]);
    // Busy elsewhere, so the route did not relink the session onto this Todo.
    expect(listWorkItemEvents(id).filter((event) => event.kind === "session_linked")).toHaveLength(1);

    expect(statusesAcrossSweeps(id)).toEqual(["executing", "executing", "executing"]);
    expect(listWorkItemEvents(id).filter((event) => event.actor === "reconciler" && event.toStatus === "blocked")).toHaveLength(1);
    expect(listWorkItemEvents(id).filter((event) => event.kind === "escalated")).toHaveLength(0);
  });

  it("blocks again when an execute attempt that ran after the move fails", async () => {
    const id = blockedByFailedRun("solo-worker");
    const sessionId = busyElsewhere("solo-worker");
    await call("POST", `/api/work-items/${id}/status`, { status: "executing" }, toolHeaders(sessionId));
    expect(statusesAcrossSweeps(id, 1)).toEqual(["executing"]);

    const retry = reg.createSession({ engine: "codex", source: "web", sourceRef: `web:retry-${++n}`, employee: "solo-worker", prompt: "work" });
    store.linkSession(id, retry.id, null, "execute");
    reg.updateSession(retry.id, { status: "error", attemptOutcome: "failed", lastActivity: new Date(Date.now() + 5_000).toISOString() });

    expect(statusesAcrossSweeps(id, 1)).toEqual(["blocked"]);
  });

  it("stops shielding the Todo once it is handed to somebody else", async () => {
    const id = blockedByFailedRun("solo-worker");
    const sessionId = busyElsewhere("solo-worker");
    await call("POST", `/api/work-items/${id}/status`, { status: "executing" }, toolHeaders(sessionId));
    const handed = await call("POST", `/api/work-items/${id}/assign`, { assignee: "platform-worker" }, toolHeaders(sessionId));
    expect(handed.status).toBe(200);

    expect(statusesAcrossSweeps(id, 1)).toEqual(["blocked"]);
  });

  it("does not shield a move made by a session of somebody other than the assignee", async () => {
    const id = blockedByFailedRun("solo-worker");
    const sessionId = busyElsewhere("platform-worker");
    const moved = await call("POST", `/api/work-items/${id}/status`, { status: "executing" }, toolHeaders(sessionId));
    expect(moved.status).toBe(200);

    expect(statusesAcrossSweeps(id, 1)).toEqual(["blocked"]);
  });
});
