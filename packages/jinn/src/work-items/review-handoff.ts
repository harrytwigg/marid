import { addComment, type AddCommentInput, type WorkItemComment } from './comments.js';
import { listWorkItemEvents } from './event-log.js';
import type { WriteOrigin } from './origin.js';
import { getWorkItem, type WorkItemEvent } from './store.js';

export interface ReviewNoteAuthor {
  /** The actor the move was recorded under. */
  actor: string;
  author: string;
  authorKind: AddCommentInput['authorKind'];
  sessionId?: string;
  origin?: WriteOrigin;
}

/** The note the Todo's latest move carried, when that move was a review
 *  handoff (into `in_review`) or a review bounce (sent back out of it), `actor`
 *  made it, and the Todo still stands where it put it. */
function pendingReviewNote(workItemId: string, actor: string): { eventId: string; note: string } | undefined {
  const move = listWorkItemEvents(workItemId)
    .filter((event) => (event.kind === 'status_change' || event.kind === 'escalated') && event.toStatus !== null)
    .at(-1);
  if (!move || move.actor !== actor || getWorkItem(workItemId)?.status !== move.toStatus) return undefined;
  const note = isReviewMove(move) ? noteOf(move) : '';
  return note ? { eventId: move.id, note } : undefined;
}

function isReviewMove(move: WorkItemEvent): boolean {
  return move.toStatus === 'in_review' || (move.fromStatus === 'in_review' && move.detail?.bounce === true);
}

function noteOf(move: WorkItemEvent): string {
  return typeof move.detail?.note === 'string' ? move.detail.note.trim() : '';
}

/**
 * Post the note a review move carried as a comment on the Todo: the summary
 * handed in with a move into `in_review`, or the feedback sent with the work
 * when the operator sends it back.
 *
 * Keyed on the status event itself, so it is posted once however the post is
 * retried: a caller whose move committed but whose comment did not can send the
 * same move again (now a same-status no-op) and the note still lands. Only the
 * caller that made the move posts it, and only while the Todo is still where
 * that move put it.
 */
export function postReviewNote(workItemId: string, by: ReviewNoteAuthor): WorkItemComment | undefined {
  const pending = pendingReviewNote(workItemId, by.actor);
  if (!pending) return undefined;
  const { actor: _actor, ...author } = by;
  try {
    return addComment({ workItemId, body: pending.note, ...author, idempotencyKey: `review-handoff:${pending.eventId}` });
  } catch (err) {
    // The same move's note already posted under other input: it stands.
    if (err instanceof Error && /idempotency key was already used/.test(err.message)) return undefined;
    throw err;
  }
}
