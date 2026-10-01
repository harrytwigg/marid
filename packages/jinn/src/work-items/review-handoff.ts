import { addComment, type AddCommentInput, type WorkItemComment } from './comments.js';
import { listWorkItemEvents } from './event-log.js';
import type { WriteOrigin } from './origin.js';
import { getWorkItem } from './store.js';

export interface ReviewHandoffAuthor {
  /** The actor the move into `in_review` was recorded under. */
  actor: string;
  author: string;
  authorKind: AddCommentInput['authorKind'];
  sessionId?: string;
  origin?: WriteOrigin;
}

/** The summary the latest move into review carried, when `actor` made it and
 *  the Todo is still in review on it. */
function pendingHandoff(workItemId: string, actor: string): { eventId: string; note: string } | undefined {
  if (getWorkItem(workItemId)?.status !== 'in_review') return undefined;
  const move = listWorkItemEvents(workItemId)
    .filter((event) => event.kind === 'status_change' && event.toStatus === 'in_review')
    .at(-1);
  const note = typeof move?.detail?.note === 'string' ? move.detail.note.trim() : '';
  return move && note && move.actor === actor ? { eventId: move.id, note } : undefined;
}

/**
 * Post the summary a move into `in_review` carried as a comment on the Todo:
 * the review handoff the operator reads.
 *
 * Keyed on the status event itself, so it is posted once however the post is
 * retried: a caller whose move committed but whose comment did not can send the
 * same move again (now a same-status no-op) and the handoff still lands. Only
 * the caller that made the move posts it, and only while the Todo is still in
 * review on that move.
 */
export function postReviewHandoff(workItemId: string, by: ReviewHandoffAuthor): WorkItemComment | undefined {
  const handoff = pendingHandoff(workItemId, by.actor);
  if (!handoff) return undefined;
  const { actor: _actor, ...author } = by;
  try {
    return addComment({ workItemId, body: handoff.note, ...author, idempotencyKey: `review-handoff:${handoff.eventId}` });
  } catch (err) {
    // The same move's handoff already posted under other input: it stands.
    if (err instanceof Error && /idempotency key was already used/.test(err.message)) return undefined;
    throw err;
  }
}
