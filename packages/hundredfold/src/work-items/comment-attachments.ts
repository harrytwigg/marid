import { initDb } from '../shared/db.js';
import type { WorkItemAttachment } from './attachments.js';

/**
 * What a comment carries. Its own module because it exists for one reason a
 * plain attachment listing does not: a parked workflow Wait resumes on an
 * operator's reply, and the files attached to that reply are half the answer.
 */

/** Just enough of an attachment row to reference it: no filename, no on-disk
 *  path. What a surface outside the store is given to point at the bytes. */
export type WorkItemAttachmentHandle = Pick<WorkItemAttachment, 'id' | 'mime'>;

/** The handles for one comment's own attachments, oldest first. Tombstoning a
 *  comment leaves its rows in place, so a run resumed by a reply still sees
 *  what was attached to it. */
export function listCommentAttachments(commentId: string): WorkItemAttachmentHandle[] {
  return (
    initDb()
      .prepare('SELECT id, mime FROM work_item_attachments WHERE comment_id = ? ORDER BY created_at, rowid')
      .all(commentId) as Record<string, unknown>[]
  ).map((row) => ({ id: row.id as string, mime: row.mime as string }));
}

export type TodoAttachmentListener = (attachment: WorkItemAttachment) => void;

let todoAttachmentListener: TodoAttachmentListener | null = null;

export function setTodoAttachmentListener(listener: TodoAttachmentListener | null): void {
  todoAttachmentListener = listener;
}

/** Announce a committed attachment and hand it straight back, so the store can
 *  announce on its way out. A reply arrives as a comment and THEN its uploads,
 *  one request each, so this is the only signal that says more of it landed.
 *  Best-effort like the comment listener: a subscriber that throws must never
 *  break the write it observed. */
export function announceAttachment(attachment: WorkItemAttachment): WorkItemAttachment {
  try {
    todoAttachmentListener?.(attachment);
  } catch {
    /* best-effort bridge */
  }
  return attachment;
}
