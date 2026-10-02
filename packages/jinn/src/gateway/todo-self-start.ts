import { logger } from "../shared/logger.js";
import type { Session } from "../shared/types.js";
import { getSession } from "../sessions/registry.js";
import { toWorkItemLinkRole } from "../work-items/link-role.js";
import { openWorkItemRun } from "../work-items/runs.js";
import { getWorkItem, linkSession, STICKY_STATUSES, type WorkItem } from "../work-items/store.js";
import type { WorkItemCaller } from "./work-item-arming.js";

/**
 * A session starting a Todo of its own employee's, with no dispatch.
 *
 * The dispatch and delegation paths link the session they start and open its
 * run before the turn runs. A session that creates a Todo, assigns it to its
 * own employee and moves it to `executing` goes through none of them, so the
 * Todo read as executing with nobody on it: no linked session, no run, and
 * nothing for Dispatch or recovery to see as its live attempt. This gives that
 * path the same link and run.
 *
 * Only the assignee's own session is linked; moving or assigning a Todo that
 * belongs to somebody else links nobody. A session already executing another
 * Todo that is still open keeps that link — a session carries one Todo, and
 * taking it would orphan the other one's attempt. A link to a Todo that has
 * been handed to review or closed is the producer's finished attempt, and its
 * run stays on that Todo's ledger, so the session moves on to the new one.
 *
 * The link is marked self-started, and it holds while the Todo is worked: a
 * chat keeps running turns after its Todo is put down, so the move back to the
 * backlog releases it (`releaseSelfStartedLinks`) rather than letting the next
 * turn pull the Todo back to `executing`.
 *
 * Callers make this call only for a move that actually started the Todo or
 * actually gave it to the caller's employee. A repeated no-op call from another
 * session of the same employee must not pull that session onto the Todo.
 *
 * Returns the Todo as it stands afterwards: a link bumps its version, and the
 * caller hands that version back to the agent for its next write.
 */
export function linkSelfStartedTodo(caller: WorkItemCaller, item: WorkItem, actor: string): WorkItem {
  if (caller.kind !== "session" || item.status !== "executing") return item;
  const session = getSession(caller.callerId);
  if (!session?.employee || session.employee !== item.assignee || !mayLinkAsExecutor(session, item)) return item;
  try {
    linkSession(item.id, session.id, actor, "execute", { selfStarted: true });
    openWorkItemRun({ workItemId: item.id, sessionId: session.id });
  } catch (error) {
    logger.warn(`Todo ${item.id}: linking self-started session ${session.id} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return getWorkItem(item.id) ?? item;
}

function mayLinkAsExecutor(session: Session, item: WorkItem): boolean {
  // Already on this Todo for another reason (a review, a mention): the role
  // is what the self-review ban reads, so it is left as it is.
  if (session.workItemId === item.id) return toWorkItemLinkRole(session.workItemRole) === "execute";
  if (!session.workItemId) return true;
  const current = getWorkItem(session.workItemId);
  if (!current || current.status === "in_review" || STICKY_STATUSES.has(current.status)) return true;
  logger.info(`Todo ${item.id}: session ${session.id} stays linked to ${current.id} (${current.status}); not relinked`);
  return false;
}
