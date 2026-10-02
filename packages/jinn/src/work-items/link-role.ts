import type { Session, WorkItemLinkRole } from '../shared/types.js';
import { isLegacyWorkflowPhaseSession } from '../sessions/legacy-workflow-phase.js';

/**
 * Why a session is linked to a Todo.
 *
 * The link answers two different questions that used to have one answer. "Whose
 * spend is this?" wants every session that touched the Todo; "who produced this
 * work?" wants only the ones that did it. The self-review ban asks the second
 * question, so a reviewer delegated onto a Todo — linked so their rounds are
 * attributed and their comments route — was read as its producer and refused
 * the one transition a reviewer exists to make.
 *
 * `execute` is the default and the legacy meaning: a NULL column is an
 * execution attempt, so nothing already in the database changes meaning.
 */
export type { WorkItemLinkRole };

/** The roles a delegation may ask for. `consult` is not one: only a mention
 *  links a session that way. */
export const WORK_ITEM_LINK_ROLES: readonly WorkItemLinkRole[] = ['execute', 'review'];

/** Parse a role off the wire or out of a column. Anything unrecognised —
 *  including NULL — is an execution attempt, the pre-existing meaning. */
export function toWorkItemLinkRole(value: unknown): WorkItemLinkRole {
  return value === 'review' || value === 'consult' ? value : 'execute';
}

/**
 * Whether a linked session counts as having EXECUTED the Todo.
 *
 * The exclusions are the same rule seen from different angles: a phase
 * session left by the removed Workflow runtime (source `workflow`) was linked
 * so a run's spend rolled up to the Todo it was bound to, a review session is
 * linked so a review round is attributed and steerable, and a consulted
 * session was tagged in a comment and asked for an answer. None produced the
 * work, so none may be treated as its producer — by the self-review ban, by
 * the status derivation that reads attempt receipts, or by Dispatch.
 */
export function isExecutionAttempt(session: Session): boolean {
  return !isLegacyWorkflowPhaseSession(session)
    && toWorkItemLinkRole(session.workItemRole) === 'execute';
}

/**
 * The role a delegation's link should carry.
 *
 * Explicit `intent` wins; otherwise the Todo's own status decides. A Todo that
 * is already `in_review` when someone delegates onto it is being handed to a
 * reviewer — that is what `in_review` MEANS, and it is the flow the doctrine
 * prescribes (the producer submits, then hands off). Inferring it keeps every
 * existing caller working without a new argument, while `intent: 'review'`
 * stays available for a reviewer brought in before the submission.
 */
export function resolveDelegationLinkRole(intent: WorkItemLinkRole | undefined, todoStatus: string): WorkItemLinkRole {
  if (intent) return intent;
  return todoStatus === 'in_review' ? 'review' : 'execute';
}
