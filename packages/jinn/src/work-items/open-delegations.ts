import { initDb } from "../shared/db.js";
import type { Session } from "../shared/types.js";
import { listChildSessions } from "../sessions/registry.js";
import { hasLiveBackgroundWork } from "../sessions/background-work.js";
import { EXECUTION_TIMEOUT_MS } from "./recovery.js";

/**
 * Whether a parent is still waiting on its own delegation tree.
 *
 * A Todo whose producer split it into sub-tasks, delegated, or spawned a
 * reviewer is not stalled while that work runs: it stays `executing`, its turn
 * ends, and each result wakes it. Only work that is actually running counts. A
 * `backlog` sub-task nobody has started, a `blocked` one waiting on a person
 * and an `in_review` one waiting on the operator will not wake the parent, so
 * they leave the parent to the ordinary stall check.
 */

/** A session whose work is still happening: running, waiting, or idle with background work live. */
export function isSessionInFlight(session: Pick<Session, "id" | "status">): boolean {
  return session.status === "running" || session.status === "waiting"
    || (session.status === "idle" && hasLiveBackgroundWork(session.id));
}

function hasExecutingSubTask(workItemId: string): boolean {
  return initDb()
    .prepare("SELECT 1 FROM work_items WHERE parent_id = ? AND status = 'executing' LIMIT 1")
    .get(workItemId) !== undefined;
}

/** A child row still marked in flight long after it last spoke is stale, not working. */
function hasInFlightChildSession(parentIds: readonly string[], now: number): boolean {
  return parentIds.some((id) => listChildSessions(id).some((child) =>
    isSessionInFlight(child) && now - (Date.parse(child.lastActivity) || 0) < EXECUTION_TIMEOUT_MS));
}

/** Whether the Todo's execution `attempts` have an `executing` sub-task, or an in-flight session they started. */
export function hasOpenDelegations(workItemId: string, attempts: readonly Pick<Session, "id">[], now = Date.now()): boolean {
  return hasExecutingSubTask(workItemId) || hasInFlightChildSession(attempts.map((session) => session.id), now);
}
