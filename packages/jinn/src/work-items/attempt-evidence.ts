import { latestAssigneeExecutingDeclaredAt, latestEvidenceFloorAt } from './event-log.js';
import { closeWorkItemRun, findOpenWorkItemRunBySession, runOutcomeForReceipt } from './runs.js';
import { getSession, listSessionsByWorkItem } from '../sessions/registry.js';
import { settledAttemptOutcome } from '../sessions/restart-resume-window.js';
import { isExecutionAttempt } from './link-role.js';
import { logger } from '../shared/logger.js';
import type { Session, SessionAttemptOutcome } from '../shared/types.js';
import type { WorkItemStatus } from './store.js';

/**
 * What a Todo's execution attempts say, and as of when.
 *
 * The reconciler derives status from linked sessions; this module decides which
 * of them still get to speak. It also settles the run ledger from the same
 * receipts, because the two readings must agree about what an attempt did.
 */

/** Session lifecycle states, mirrored from `Session.status` in shared/types.ts. */
export type SessionStatus = 'idle' | 'running' | 'error' | 'waiting' | 'interrupted';

export interface WorkItemAttemptEvidence {
  status: SessionStatus;
  outcome: SessionAttemptOutcome | null;
}

/** What a Todo's attempts say, and what the operator said last. */
export interface WorkItemAttemptReading {
  /** The receipts still entitled to speak, newest-first. */
  attempts: WorkItemAttemptEvidence[];
  /** When the operator last moved this Todo himself, or an expired park last put
   *  it back in the queue — whichever is newer, if either ever happened. Attempts
   *  at or before it were dropped; an empty `attempts` alongside it means nothing
   *  has happened since that decision. */
  decisionFloorAt?: string;
}

/**
 * Settle the run ledger from the same receipts the status derivation reads, so
 * a Todo's attempt history closes the moment its attempts do. Best-effort per
 * session: a ledger write is reporting, and reporting must never break the
 * status the platform actually routes on.
 *
 * Callers pass sessions with Workflow phase sessions already filtered out — the
 * workflow runner settles those runs itself, and racing it would close a phase
 * attempt the run is still retrying.
 */
function closeRunsForSettledAttempts(sessions: readonly Session[]): void {
  for (const session of sessions) {
    const outcome = settledAttemptOutcome(session);
    if (!outcome) continue;
    try {
      const run = findOpenWorkItemRunBySession(session.id);
      // Read the receipt through the same rate-limit-aware reading the sweep
      // uses. Whichever of the two reaches an attempt first must settle it the
      // same way, or a quota window becomes `blocked` purely because the
      // reconciler got there first — and `blocked` is what the respawn guards
      // read as "a human has to clear this".
      if (run) closeWorkItemRun(run.id, { outcome: runOutcomeForReceipt(outcome, session.lastError) });
    } catch (err) {
      logger.warn(`Run ledger close for session ${session.id} skipped: ${err instanceof Error ? err.message : err}`);
    }
  }
}

/**
 * Drop the attempts that predate the operator's own most recent status move.
 * A receipt written before he decided where the Todo belongs says
 * nothing about what happened after the decision, and deriving from one reverts
 * him — a ten-day-old `succeeded` session pulled a Todo he had just
 * parked in `backlog` into `in_review`, three seconds later.
 *
 * The floor is causal rather than a time window, so it clears itself: the moment
 * an attempt actually does something its `last_activity` passes the floor and
 * derivation resumes. A session that is genuinely live keeps touching
 * `last_activity`, so work happening right now still derives `executing` — that
 * is honest evidence in a way a settled corpse is not.
 *
 * Actor `operator` raises a floor, and so does an expired park: the
 * sweep that ends a park re-queues the Todo on a date somebody chose, and the
 * attempt that ran before the park says nothing about the work after it. An
 * agent-declared move keeps today's behaviour: the declared-block and
 * review-bounce guards already cover those.
 */
function attemptsAfterDecision(floor: string | undefined, sessions: readonly Session[]): readonly Session[] {
  if (!floor) return sessions;
  return sessions.filter((session) => session.lastActivity > floor);
}

/**
 * Drop the attempts that predate the assignee's own declared move to
 * `executing`. The assignee may take a stopped Todo from a session that is not
 * linked as an execution attempt (a mention links `consult`), so the attempts
 * still counted are older runs that ended badly, and deriving from them undoes
 * the move seconds later. Like the operator's floor it is causal: an attempt
 * that runs after the declaration passes it and speaks again, so a newer failed
 * run still blocks the Todo. It applies only while the Todo sits `executing`
 * from that declaration; a review bounce keeps its own guard.
 */
function attemptsAfterAssigneeResume(
  workItemId: string,
  currentStatus: WorkItemStatus | undefined,
  sessions: readonly Session[],
): readonly Session[] {
  if (currentStatus !== 'executing' || sessions.length === 0) return sessions;
  const declaredAt = latestAssigneeExecutingDeclaredAt(workItemId, (sessionId) => getSession(sessionId)?.employee ?? undefined);
  return attemptsAfterDecision(declaredAt, sessions);
}

/**
 * One attempt's evidence. A turn the restart interrupted and the gateway is
 * about to resume (queue replay or restart nudge) is still in flight, not a
 * settled interruption: reading it as settled would block the Todo and wake its
 * parent's owner for a turn that resumes seconds later (`settledAttemptOutcome`).
 */
function attemptEvidence(session: Session): WorkItemAttemptEvidence {
  const outcome = settledAttemptOutcome(session);
  if (session.attemptOutcome && !outcome) return { status: 'running', outcome: null };
  return { status: session.status as SessionStatus, outcome };
}

/**
 * The receipts a Todo's status may be derived from, newest-first (the ordering
 * `listSessionsByWorkItem` returns and `deriveWorkItemStatus` relies on).
 * Settles the run ledger on the way through, for every non-phase attempt —
 * bookkeeping about a finished attempt stays true regardless of whether that
 * attempt still counts as evidence.
 */
export function collectAttemptEvidence(workItemId: string, currentStatus?: WorkItemStatus): WorkItemAttemptReading {
  // A legacy Workflow phase session is linked to its Todo only so its spend
  // rolled up there; it never produced the Todo's work, so its receipt is not
  // evidence about the Todo's status (isExecutionAttempt).
  const sessions = listSessionsByWorkItem(workItemId).filter(isExecutionAttempt);
  closeRunsForSettledAttempts(sessions);
  const decisionFloorAt = latestEvidenceFloorAt(workItemId);
  const afterDecision = attemptsAfterDecision(decisionFloorAt, sessions);
  return {
    decisionFloorAt,
    attempts: attemptsAfterAssigneeResume(workItemId, currentStatus, afterDecision).map(attemptEvidence),
  };
}
