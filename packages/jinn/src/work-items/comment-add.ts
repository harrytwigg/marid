import { createHash, randomUUID } from 'node:crypto';
import { initDb } from '../shared/db.js';
import { recordCommentMeta, withCommentMeta } from './comment-meta.js';
import { parseTodoId } from './id.js';
import { appendWorkItemEvent } from './store.js';
import {
  WorkItemCommentError,
  notifyTodoComment,
  type AddCommentInput,
  type WorkItemComment,
} from './comments.js';

function rowToComment(row: Record<string, unknown>): WorkItemComment {
  return {
    id: row.id as string,
    workItemId: row.work_item_id as string,
    parentCommentId: (row.parent_comment_id as string) ?? null,
    authorKind: row.author_kind as WorkItemComment['authorKind'],
    author: row.author as string,
    body: row.body as string,
    createdAt: row.created_at as string,
    editedAt: (row.edited_at as string) ?? null,
    deletedAt: (row.deleted_at as string) ?? null,
  };
}

function getComment(db: ReturnType<typeof initDb>, id: string): WorkItemComment | undefined {
  const row = db.prepare('SELECT * FROM work_item_comments WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? withCommentMeta(db, [rowToComment(row)])[0] : undefined;
}

function operationCommentId(key: string): string {
  if (!key || key.length > 256) throw new Error('comment idempotency key must be between 1 and 256 characters');
  return `wic_${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
}

function commentFingerprint(input: AddCommentInput, workItemId: string, parentCommentId: string | null): string {
  return createHash('sha256').update(JSON.stringify({
    workItemId,
    parentCommentId,
    authorKind: input.authorKind,
    author: input.author,
    body: input.body,
    origin: input.origin ?? null,
  })).digest('hex');
}

function originalFingerprint(db: ReturnType<typeof initDb>, workItemId: string, commentId: string): string | null {
  const rows = db.prepare(
    "SELECT detail FROM work_item_events WHERE work_item_id = ? AND kind = 'comment_added' ORDER BY created_at, rowid",
  ).all(workItemId) as Array<{ detail: string | null }>;
  for (const row of rows) {
    if (!row.detail) continue;
    try {
      const detail = JSON.parse(row.detail) as { commentId?: unknown; idempotencyFingerprint?: unknown };
      if (detail.commentId === commentId && typeof detail.idempotencyFingerprint === 'string') {
        return detail.idempotencyFingerprint;
      }
    } catch {
      // An unrelated malformed historical event is not this operation's proof.
    }
  }
  return null;
}

function resolvedParentId(db: ReturnType<typeof initDb>, input: AddCommentInput, workItemId: string): string | null {
  if (!input.parentCommentId) return null;
  const parent = getComment(db, input.parentCommentId);
  if (!parent) throw new WorkItemCommentError('comment-not-found', `parent comment ${input.parentCommentId} not found`);
  if (parent.workItemId !== workItemId) {
    throw new WorkItemCommentError('comment-not-found', `parent comment ${parent.id} belongs to a different Todo (${parent.workItemId})`);
  }
  return parent.parentCommentId ?? parent.id;
}

function replayedComment(
  db: ReturnType<typeof initDb>,
  comment: WorkItemComment,
  fingerprint: string | null,
): WorkItemComment | undefined {
  if (!fingerprint) return undefined;
  const existing = getComment(db, comment.id);
  if (!existing) return undefined;
  if (originalFingerprint(db, comment.workItemId, comment.id) !== fingerprint) {
    throw new Error('comment idempotency key was already used for different input');
  }
  return existing;
}

function insertComment(
  db: ReturnType<typeof initDb>,
  comment: WorkItemComment,
  input: AddCommentInput,
  fingerprint: string | null,
): void {
  db.prepare(
    `INSERT INTO work_item_comments (id, work_item_id, parent_comment_id, author_kind, author, body, created_at, edited_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
  ).run(comment.id, comment.workItemId, comment.parentCommentId, comment.authorKind, comment.author, comment.body, comment.createdAt);
  recordCommentMeta(db, comment.id, { sessionId: comment.sessionId, repliedToId: comment.repliedToId });
  appendWorkItemEvent({
    workItemId: comment.workItemId,
    kind: 'comment_added',
    actor: input.author,
    detail: {
      commentId: comment.id,
      ...(input.origin ? { origin: input.origin } : {}),
      ...(fingerprint ? { idempotencyFingerprint: fingerprint } : {}),
    },
    versionEffect: 'state',
  });
}

/** Add a comment or replay the first durable machine operation atomically. */
export function addComment(input: AddCommentInput): WorkItemComment {
  const db = initDb();
  const workItemId = parseTodoId(input.workItemId);
  if (!input.body || !input.body.trim()) throw new Error('comment body must not be empty');
  const operationId = input.idempotencyKey ? operationCommentId(input.idempotencyKey) : null;
  const comment: WorkItemComment = {
    id: operationId ?? `wic_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    workItemId,
    parentCommentId: null,
    authorKind: input.authorKind,
    author: input.author,
    body: input.body,
    createdAt: new Date().toISOString(),
    editedAt: null,
    deletedAt: null,
  };
  const commit = db.transaction((): { comment: WorkItemComment; replayed: boolean } => {
    if (!db.prepare('SELECT 1 FROM work_items WHERE id = ?').get(workItemId)) {
      throw new Error(`Todo ${workItemId} not found`);
    }
    comment.parentCommentId = resolvedParentId(db, input, workItemId);
    // The comment a reply answered, before flattening re-parents it to the root.
    if (input.parentCommentId) comment.repliedToId = input.parentCommentId;
    if (input.sessionId) comment.sessionId = input.sessionId;
    const fingerprint = operationId ? commentFingerprint(input, workItemId, comment.parentCommentId) : null;
    const existing = replayedComment(db, comment, fingerprint);
    if (existing) return { comment: existing, replayed: true };
    insertComment(db, comment, input, fingerprint);
    return { comment, replayed: false };
  });
  const committed = commit();
  if (!committed.replayed) notifyTodoComment(committed.comment);
  return committed.comment;
}
