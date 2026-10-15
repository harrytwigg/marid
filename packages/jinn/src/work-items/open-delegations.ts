import { initDb } from "../shared/db.js";
import type { Session } from "../shared/types.js";
import { listChildSessions, listSessionsByWorkItem } from "../sessions/registry.js";
import { hasLiveBackgroundWork } from "../sessions/background-work.js";
import { isExecutionAttempt } from "./link-role.js";

/**
 * Whether a parent is still waiting on its own delegation tree.
 *
 * A session that delegated Todos, spawned a reviewer, or split its Todo into
 * sub-tasks is not stalled while that work runs: it stays `executing` and ends
 * its turn, and each result wakes it. Only a wait on someone outside its own
 * tree is `blocked`. `in_review` sub-tasks are on the operator's desk, so they
 * no longer keep the parent waiting on anyone below it.
 */

/** A session whose work is still happening: running, waiting, or idle with background work live. */
export function isSessionInFlight(session: Pick<Session, "id" | "status">): boolean {
  return session.status === "running" || session.status === "waiting"
    || (session.status === "idle" && hasLiveBackgroundWork(session.id));
}

/** Sub-tasks of the Todo that are neither handed in nor closed. */
export function hasOpenSubTasks(workItemId: string): boolean {
  return initDb()
    .prepare("SELECT 1 FROM work_items WHERE parent_id = ? AND status NOT IN ('in_review', 'done', 'cancelled') LIMIT 1")
    .get(workItemId) !== undefined;
}

/** Whether any session `parentIds` started (a delegation, a reviewer) is still in flight. */
function hasInFlightChildSession(parentIds: readonly string[]): boolean {
  return parentIds.some((id) => listChildSessions(id).some(isSessionInFlight));
}

/** For the Todo's execution attempts: open sub-tasks, or in-flight sessions they started. */
export function todoHasOpenDelegations(workItemId: string): boolean {
  return hasOpenSubTasks(workItemId)
    || hasInFlightChildSession(listSessionsByWorkItem(workItemId).filter(isExecutionAttempt).map((s) => s.id));
}

/** For one session: open sub-tasks of its Todo, or in-flight sessions it started. */
export function sessionHasOpenDelegations(session: Pick<Session, "id" | "workItemId">): boolean {
  return (session.workItemId ? hasOpenSubTasks(session.workItemId) : false)
    || hasInFlightChildSession([session.id]);
}
