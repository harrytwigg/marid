/**
 * The Todo comment thread's wire shapes.
 *
 * Moved out of `api.ts` unchanged so the run ledger could be added there without
 * the file growing: the thread is a self-contained lane — three shapes, no
 * dependency on any other work-item type — and `api.ts` re-exports all of it, so
 * no caller had to move with it.
 */

export type WorkItemCommentAuthorKindWire = "operator" | "employee" | "system"

/** One comment row (Todos v2 slice 2). A tombstoned comment keeps its row with
 *  an empty body and a `deletedAt` stamp so the thread shape survives. */
export interface WorkItemCommentWire {
  id: string
  workItemId: string
  parentCommentId: string | null
  authorKind: WorkItemCommentAuthorKindWire
  author: string
  body: string
  createdAt: string
  editedAt: string | null
  deletedAt: string | null
  /** The session that wrote the comment; absent when the gateway has none. */
  sessionId?: string
  /** The comment a reply actually answered, before the thread was flattened to
   *  its root; absent when unknown. */
  repliedToId?: string
}

/** A chronological comment page; `total` is the exact per-item count. */
export interface WorkItemCommentPageWire {
  comments: WorkItemCommentWire[]
  total: number
  limit?: number
  offset?: number
}
