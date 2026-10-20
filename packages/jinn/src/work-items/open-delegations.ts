import { initDb } from "../shared/db.js";
import type { Session } from "../shared/types.js";
import { listChildSessions } from "../sessions/registry.js";
import { hasLiveBackgroundWork } from "../sessions/background-work.js";
import { EXECUTION_TIMEOUT_MS } from "./recovery.js";
import { hasPendingChildSettles } from "./child-settles.js";

/**
 * Whether a parent is still waiting on its own delegation tree.
 *
 * A Todo whose producer split it into sub-tasks, delegated, or spawned a
 * reviewer is not stalled while that work runs: it stays `executing`, its turn
 * ends, and each result wakes it. Only work that is actually running counts. A
 * `backlog` sub-task nobody has started and a `blocked` one waiting on a person
 * will not wake the parent, so they leave the parent to the ordinary stall check.
 *
 * A wake that is on its way counts too: a child that has settled and whose
 * parent has not yet been told (a `work_item_child_settles` row still pending,
 * or its `todo-child-settled` delivery still `pending` in the outbox) means the
 * parent is not idle, only about to be woken. Once the parent has been woken, a
 * child sitting in `in_review` is not an open delegation: the next move is the
 * parent's own, so the ordinary stall clock runs from that wake.
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

/** A `todo-child-settled` delivery for this Todo that has not been accepted yet. */
function hasPendingChildSettledDelivery(workItemId: string, attemptIds: readonly string[]): boolean {
  const targets = attemptIds.length === 0 ? "" : ` OR target_session_id IN (${attemptIds.map(() => "?").join(", ")})`;
  return initDb()
    .prepare(`SELECT 1 FROM callback_deliveries
      WHERE delivery_kind = 'todo-child-settled' AND status = 'pending' AND (source_id = ?${targets}) LIMIT 1`)
    .get(workItemId, ...attemptIds) !== undefined;
}

/** A child row still marked in flight long after it last spoke is stale, not working. */
function hasInFlightChildSession(parentIds: readonly string[], now: number): boolean {
  return parentIds.some((id) => listChildSessions(id).some((child) =>
    isSessionInFlight(child) && now - (Date.parse(child.lastActivity) || 0) < EXECUTION_TIMEOUT_MS));
}

/** Whether the Todo's execution `attempts` have an `executing` sub-task, an in-flight session they
 *  started, or a wake about a settled child that has not reached them yet. */
export function hasOpenDelegations(workItemId: string, attempts: readonly Pick<Session, "id">[], now = Date.now()): boolean {
  const attemptIds = attempts.map((session) => session.id);
  return hasExecutingSubTask(workItemId)
    || hasInFlightChildSession(attemptIds, now)
    || hasPendingChildSettles(workItemId)
    || hasPendingChildSettledDelivery(workItemId, attemptIds);
}
