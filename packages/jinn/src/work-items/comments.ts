import { initDb } from '../shared/db.js';
import { listCommentAttachments, type WorkItemAttachmentHandle } from './comment-attachments.js';
import { parseTodoId } from './id.js';
import type { WriteOrigin } from './origin.js';
import { withCommentMeta } from './comment-meta.js';
import { appendWorkItemEvent } from './store.js';

/**
 * Work-item comments — the mutable human/agent discussion layer of the Todos
 * ledger (Todos v2 slice 2). `work_item_events` stays pure machine audit; every
 * comment mutation here records its audit event in the same transaction.
 *
 * Semantics (design decisions, locked):
 * - Threading is single-level: a comment is top-level or replies to a TOP-LEVEL
 *   comment. Replying to a reply re-parents to the thread root (Slack model).
 * - Delete = tombstone: body is cleared and `deleted_at` stamped; the row and
 *   the thread shape survive. Tombstones cannot be edited; replying to one is
 *   fine.
 * - Authority: anyone identified may comment; edit/tombstone is author-only,
 *   plus the operator surface for any comment.
 * - `comment_added` bumps the Todo version (activity resorts lists);
 *   `comment_edited`/`comment_deleted` are audit-only.
 */

export interface WorkItemComment {
  id: string; // wic_<12hex>
  workItemId: string;
  parentCommentId: string | null;
  authorKind: 'operator' | 'employee' | 'system';
  author: string;
  /** '' when tombstoned. */
  body: string;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  /** The session that wrote it, when a session did (`comment-meta.ts`). */
  sessionId?: string;
  /** The comment it replied to before flattening, when it was a reply. */
  repliedToId?: string;
}

export interface AddCommentInput {
  workItemId: string;
  body: string;
  author: string;
  authorKind: WorkItemComment['authorKind'];
  parentCommentId?: string | null;
  /** The writer's session, from its verified caller identity. */
  sessionId?: string;
  /** The surface the write was issued from, when the request declared one. */
  origin?: WriteOrigin;
  /** Stable machine-operation identity. When present, an exact retry returns
   *  the first committed comment and changed input fails closed. */
  idempotencyKey?: string;
}

/** Who is attempting an edit/tombstone: the derived author identity (string AND
 *  kind — the kind discriminates the operator/system sentinel namespace from
 *  employee slugs, so a slug literally named "operator" never matches the
 *  operator's comments), plus whether the call comes from the authenticated
 *  operator surface. */
export interface CommentEditor {
  author: string;
  authorKind: WorkItemComment['authorKind'];
  operator: boolean;
}

export type TodoCommentListener = (comment: WorkItemComment) => void | Promise<void>;

let todoCommentListener: TodoCommentListener | null = null;

export function setTodoCommentListener(listener: TodoCommentListener | null): void {
  todoCommentListener = listener;
}

export function notifyTodoComment(comment: WorkItemComment): void {
  if (!todoCommentListener) return;
  try {
    const maybe = todoCommentListener(comment);
    if (maybe && typeof (maybe as Promise<void>).catch === 'function') {
      void (maybe as Promise<void>).catch(() => undefined);
    }
  } catch {
    // Best-effort bridge, same contract as the status-change listener: a
    // workflow that fails to wake must never throw out of a committed write.
  }
}

export type WorkItemCommentErrorCode = 'comment-not-found' | 'comment-forbidden' | 'comment-deleted';

export class WorkItemCommentError extends Error {
  readonly code: WorkItemCommentErrorCode;

  constructor(code: WorkItemCommentErrorCode, message: string) {
    super(message);
    this.name = 'WorkItemCommentError';
    this.code = code;
  }
}

/** Comments returned per page: default when the caller passes no limit, and the
 *  hard per-page ceiling. */
export const COMMENT_PAGE_DEFAULT_LIMIT = 50;
export const COMMENT_PAGE_MAX_LIMIT = 500;
/** Comments included in the Todo detail payload's tail. */
export const COMMENT_TAIL_DEFAULT = 10;

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

function getCommentRow(db: ReturnType<typeof initDb>, id: string): WorkItemComment | undefined {
  const row = db.prepare('SELECT * FROM work_item_comments WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToComment(row) : undefined;
}

export function getComment(id: string): WorkItemComment | undefined {
  return getCommentRow(initDb(), id);
}

export { addComment } from './comment-add.js';

/** The earliest live operator comment on `todoId` written inside the window
 *  `(after, until)` — how a parked `todo-comment` Wait node learns the operator
 *  replied while it was still listening.
 *
 *  Identity is the (kind, author) PAIR, never the string alone: an employee
 *  whose slug is literally "operator" writes `author = 'operator'` too, and the
 *  `comment_added` audit row keeps only that string. Reading the comments table
 *  is what keeps such a slug from resuming a run the operator never answered.
 *
 *  Both bounds are strict. A comment written in the same millisecond as the park
 *  is not an answer to a question it could not have seen, and the deadline
 *  instant belongs to the timeout — that is where the node stops waiting, so a
 *  reply from there on cannot be one the run was still open to. Without the
 *  upper bound a restart hours late would answer an expired park. */
/** The operator's reply as a parked Wait consumes it: the words, plus handles
 *  for whatever was attached to that comment. A screenshot is half the answer. */
export interface OperatorReply extends Pick<WorkItemComment, 'id' | 'body' | 'createdAt'> {
  attachments: WorkItemAttachmentHandle[];
}

export function firstOperatorCommentAfter(
  workItemId: string,
  after: string,
  until: string,
): OperatorReply | undefined {
  const db = initDb();
  const row = db.prepare(
    `SELECT id, body, created_at FROM work_item_comments
     WHERE work_item_id = ? AND author_kind = 'operator' AND author = 'operator'
       AND deleted_at IS NULL AND created_at > ? AND created_at < ?
     ORDER BY created_at, rowid LIMIT 1`,
  ).get(parseTodoId(workItemId), after, until) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  const id = row.id as string;
  return { id, body: row.body as string, createdAt: row.created_at as string,
    attachments: listCommentAttachments(id) };
}

function requireEditable(db: ReturnType<typeof initDb>, id: string, editor: CommentEditor, action: string): WorkItemComment {
  const comment = getCommentRow(db, id);
  if (!comment) throw new WorkItemCommentError('comment-not-found', `comment ${id} not found`);
  // Author identity is (author, authorKind) as a PAIR — the string alone would
  // let an employee slug that collides with a sentinel ("operator"/"system")
  // claim another principal's comments.
  if (!editor.operator && (editor.author !== comment.author || editor.authorKind !== comment.authorKind)) {
    throw new WorkItemCommentError('comment-forbidden', `only the comment author (or the operator) may ${action} it`);
  }
  return comment;
}

/** Edit a comment's body. Author-or-operator; tombstones cannot be edited. */
export function editComment(id: string, body: string, editor: CommentEditor): WorkItemComment {
  const db = initDb();
  if (!body || !body.trim()) throw new Error('comment body must not be empty');
  const txn = db.transaction((): WorkItemComment => {
    const comment = requireEditable(db, id, editor, 'edit');
    if (comment.deletedAt) {
      throw new WorkItemCommentError('comment-deleted', `comment ${id} was deleted and cannot be edited`);
    }
    const now = new Date().toISOString();
    db.prepare('UPDATE work_item_comments SET body = ?, edited_at = ? WHERE id = ?').run(body, now, id);
    appendWorkItemEvent({
      workItemId: comment.workItemId,
      kind: 'comment_edited',
      actor: editor.operator ? 'operator' : editor.author,
      detail: { commentId: id },
      versionEffect: 'audit', // wordsmithing never churns the Todo version
    });
    return { ...comment, body, editedAt: now };
  });
  return txn();
}

/** Tombstone a comment: body cleared, `deleted_at` stamped, row and thread shape
 *  retained. Author-or-operator. Idempotent — deleting a tombstone is a no-op.
 *
 *  `origin` is the surface the deletion was issued from, same audit colour as
 *  `addComment`'s: taking a spoken comment back is itself a talk write, and an
 *  audit that labels the add but not its reversal tells half the story. */
export function tombstoneComment(id: string, editor: CommentEditor, origin?: WriteOrigin): WorkItemComment {
  const db = initDb();
  const txn = db.transaction((): WorkItemComment => {
    const comment = requireEditable(db, id, editor, 'delete');
    if (comment.deletedAt) return comment;
    const now = new Date().toISOString();
    db.prepare("UPDATE work_item_comments SET body = '', deleted_at = ? WHERE id = ?").run(now, id);
    appendWorkItemEvent({
      workItemId: comment.workItemId,
      kind: 'comment_deleted',
      actor: editor.operator ? 'operator' : editor.author,
      detail: { commentId: id, ...(origin ? { origin } : {}) },
      versionEffect: 'audit',
    });
    return { ...comment, body: '', deletedAt: now };
  });
  return txn();
}

export interface CommentPage {
  comments: WorkItemComment[];
  /** Exact per-item comment count, before LIMIT/OFFSET. */
  total: number;
}

/** List a Todo's comments chronologically (oldest first) with LIMIT/OFFSET
 *  paging. An unknown Todo simply reads as empty — existence 404s belong to the
 *  route layer. */
export function listComments(workItemId: string, opts?: { limit?: number; offset?: number }): CommentPage {
  const db = initDb();
  const id = parseTodoId(workItemId);
  const limit = Math.min(
    COMMENT_PAGE_MAX_LIMIT,
    typeof opts?.limit === 'number' && Number.isFinite(opts.limit) ? Math.max(0, Math.floor(opts.limit)) : COMMENT_PAGE_DEFAULT_LIMIT,
  );
  const offset = typeof opts?.offset === 'number' && Number.isFinite(opts.offset) ? Math.max(0, Math.floor(opts.offset)) : 0;
  const rows = db
    .prepare('SELECT * FROM work_item_comments WHERE work_item_id = ? ORDER BY created_at, rowid LIMIT ? OFFSET ?')
    .all(id, limit, offset) as Record<string, unknown>[];
  const total = Number(db.prepare('SELECT COUNT(*) FROM work_item_comments WHERE work_item_id = ?').pluck().get(id));
  return { comments: withCommentMeta(db, rows.map(rowToComment)), total };
}

/** The last `n` comments (default 10) in chronological order, with the exact
 *  total — the capped tail the Todo detail payload embeds. */
export function commentsTail(workItemId: string, n = COMMENT_TAIL_DEFAULT): CommentPage {
  const db = initDb();
  const id = parseTodoId(workItemId);
  const limit = Math.min(COMMENT_PAGE_MAX_LIMIT, Math.max(0, Math.floor(n)));
  const rows = db
    .prepare('SELECT * FROM work_item_comments WHERE work_item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(id, limit) as Record<string, unknown>[];
  const total = Number(db.prepare('SELECT COUNT(*) FROM work_item_comments WHERE work_item_id = ?').pluck().get(id));
  return { comments: withCommentMeta(db, rows.map(rowToComment).reverse()), total };
}
