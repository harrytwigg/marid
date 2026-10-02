import type { Database as DatabaseType } from 'better-sqlite3';

/**
 * What a comment row cannot say about itself: the session that wrote it, and
 * the comment a reply actually answered.
 *
 * Replies are flattened to the thread root on write (`comment-add.ts`), so a
 * reply to a reply is stored against the root and the comment it answered is
 * lost; it is recorded here before that happens. The session comes from the
 * caller's verified identity, never from the agent.
 *
 * A table of its own, created lazily, never a column on `work_item_comments`
 * and never in `REQUIRED_TABLE_SQL`: the boot verifier compares the Todo DB's
 * shape byte for byte, so an additive table it does not know about is the only
 * extension an existing database survives. A comment written before this table
 * existed simply has no row.
 */

export interface CommentMeta {
  /** The session that wrote the comment, when a session did. */
  sessionId?: string;
  /** The comment this one replied to, before flattening to the thread root. */
  repliedToId?: string;
}

const ready = new WeakSet<DatabaseType>();

function ensureCommentMetaTable(db: DatabaseType): void {
  if (ready.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS work_item_comment_meta (
    comment_id    TEXT PRIMARY KEY REFERENCES work_item_comments(id) ON DELETE CASCADE,
    session_id    TEXT,
    replied_to_id TEXT
  )`);
  ready.add(db);
}

/** Record a new comment's meta. Writes nothing when there is nothing to say. */
export function recordCommentMeta(db: DatabaseType, commentId: string, meta: CommentMeta): void {
  if (!meta.sessionId && !meta.repliedToId) return;
  ensureCommentMetaTable(db);
  db.prepare('INSERT OR IGNORE INTO work_item_comment_meta (comment_id, session_id, replied_to_id) VALUES (?, ?, ?)')
    .run(commentId, meta.sessionId ?? null, meta.repliedToId ?? null);
}

/** The same comments with their meta merged in. A comment with no meta row is
 *  returned as it was, so its shape is unchanged. */
export function withCommentMeta<T extends { id: string }>(db: DatabaseType, comments: T[]): Array<T & CommentMeta> {
  if (comments.length === 0) return comments;
  ensureCommentMetaTable(db);
  const rows = db
    .prepare(`SELECT comment_id, session_id, replied_to_id FROM work_item_comment_meta WHERE comment_id IN (${comments.map(() => '?').join(', ')})`)
    .all(...comments.map((comment) => comment.id)) as Array<{ comment_id: string; session_id: string | null; replied_to_id: string | null }>;
  if (rows.length === 0) return comments;
  const byId = new Map(rows.map((row) => [row.comment_id, row]));
  return comments.map((comment) => {
    const row = byId.get(comment.id);
    if (!row) return comment;
    return {
      ...comment,
      ...(row.session_id ? { sessionId: row.session_id } : {}),
      ...(row.replied_to_id ? { repliedToId: row.replied_to_id } : {}),
    };
  });
}
