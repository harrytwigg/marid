// Row model and queries for the queue_items table — the durable per-session
// turn queue. Split out of `registry.ts`, which owns the sessions and messages
// side of the same database; the table's DDL lives in `queue-items-schema.ts`.
import { randomUUID } from 'node:crypto';
import { initDb } from '../shared/db.js';
import { rotatePendingToFront } from './queue-rotation.js';
import { parseDispatchPayload, serializeDispatchPayload, type QueueDispatch } from './queue-dispatch.js';

export type { QueueDispatch } from './queue-dispatch.js';

export interface QueueItem {
  id: string;
  sessionId: string;
  sessionKey: string;
  prompt: string;
  status: "pending" | "running" | "cancelled" | "completed";
  internal: boolean;
  /** The transcript row this item will run, when the enqueuing path had one. */
  messageId: string | null;
  /** Engine-facing extras this message was sent with.
   *  Null means this row never recorded any: the dispatch closure still decides. */
  dispatch: QueueDispatch | null;
  position: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

interface QueueItemRow extends Omit<QueueItem, "internal" | "dispatch"> {
  internal: number;
  dispatch_payload: string | null;
}

function rowToQueueItem(row: QueueItemRow): QueueItem {
  const { dispatch_payload: dispatchPayload, ...rest } = row;
  return { ...rest, internal: row.internal === 1, dispatch: parseDispatchPayload(dispatchPayload) };
}

const QUEUE_ITEM_SELECT =
  "SELECT id, session_id as sessionId, session_key as sessionKey, prompt, status, internal, position, created_at as createdAt, started_at as startedAt, completed_at as completedAt, message_id as messageId, dispatch_payload FROM queue_items";

export function enqueueQueueItem(
  sessionId: string,
  sessionKey: string,
  prompt: string,
  options: { internal?: boolean; messageId?: string; dispatch?: QueueDispatch } = {},
): string {
  const db = initDb();
  const id = randomUUID();
  const position = (db.prepare(
    "SELECT COALESCE(MAX(position), 0) + 1 as pos FROM queue_items WHERE session_key = ? AND status = 'pending'"
  ).get(sessionKey) as { pos: number }).pos;
  db.prepare(
    "INSERT INTO queue_items (id, session_id, session_key, prompt, status, internal, position, created_at, message_id, dispatch_payload) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)"
  ).run(id, sessionId, sessionKey, prompt, options.internal ? 1 : 0, position, new Date().toISOString(), options.messageId ?? null,
    serializeDispatchPayload(options.dispatch ?? null));
  return id;
}

export function markQueueItemRunning(itemId: string): boolean {
  const db = initDb();
  return db.prepare("UPDATE queue_items SET status = 'running', started_at = ? WHERE id = ? AND status = 'pending'")
    .run(new Date().toISOString(), itemId).changes === 1;
}

export function markQueueItemCompleted(itemId: string): void {
  const db = initDb();
  db.prepare("UPDATE queue_items SET status = 'completed', completed_at = ? WHERE id = ?")
    .run(new Date().toISOString(), itemId);
}

export function markRunningQueueItemsCompletedForSession(sessionId: string): number {
  const db = initDb();
  const result = db.prepare(
    "UPDATE queue_items SET status = 'completed', completed_at = ? WHERE session_id = ? AND status = 'running'"
  ).run(new Date().toISOString(), sessionId);
  return result.changes;
}

export function getQueueItem(itemId: string): QueueItem | undefined {
  const db = initDb();
  const row = db.prepare(`${QUEUE_ITEM_SELECT} WHERE id = ?`).get(itemId) as QueueItemRow | undefined;
  return row ? rowToQueueItem(row) : undefined;
}

export function cancelQueueItem(itemId: string): boolean {
  const db = initDb();
  const result = db.prepare(
    "UPDATE queue_items SET status = 'cancelled' WHERE id = ? AND status = 'pending'"
  ).run(itemId);
  return result.changes > 0;
}

/**
 * Withdraw a parked operator message: cancel the queue row and drop the bubble
 * it was showing, together. A message no engine ever saw, left in the
 * transcript, reads exactly like one that was sent. Same transaction reasoning
 * as the edit below.
 *
 * Returns the withdrawn item as it was, or undefined when it is gone or has
 * already left `pending`. Its `messageId` is read inside the transaction:
 * send-now moves message ids between rows, so a caller's snapshot can be stale.
 */
export function withdrawPendingQueueItem(itemId: string): QueueItem | undefined {
  const db = initDb();
  return db.transaction(() => {
    const item = getQueueItem(itemId);
    if (!item || item.status !== 'pending') return undefined;
    db.prepare("UPDATE queue_items SET status = 'cancelled' WHERE id = ? AND status = 'pending'").run(itemId);
    if (item.messageId) db.prepare('DELETE FROM messages WHERE id = ?').run(item.messageId);
    return item;
  }).immediate();
}

/**
 * Rewrite a parked item's text, and the bubble it is showing, together.
 *
 * The two writes share a transaction because a queue row and its transcript row
 * disagreeing is the one state the chat cannot render honestly: the operator
 * would be reading one message and the engine would run another. The message
 * UPDATE is spelled out here rather than borrowed from `registry.ts` so this
 * module stays a leaf.
 *
 * Returns undefined when the item is gone or has already left `pending`.
 */
export function editPendingQueueItem(itemId: string, prompt: string): QueueItem | undefined {
  const db = initDb();
  return db.transaction(() => {
    const item = getQueueItem(itemId);
    if (!item || item.status !== 'pending') return undefined;
    db.prepare("UPDATE queue_items SET prompt = ? WHERE id = ? AND status = 'pending'").run(prompt, itemId);
    if (item.messageId) db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(prompt, item.messageId);
    return getQueueItem(itemId);
  }).immediate();
}

/**
 * Run one parked message next: give it the head of the line among the pending
 * operator-visible rows, the others keeping their relative order.
 *
 * Only the rows' positions move, in one transaction. Each row keeps its id, its
 * text, its bubble, its attachments and the dispatch its enqueuer registered, so
 * a queue item id names the same message before and after, and the message runs
 * the way it was sent. Internal rows (callback deliveries) keep their place in
 * the line. The lane's pending rows are renumbered densely while at it, because
 * positions are only unique when every row was enqueued in one process lifetime:
 * a row put back to pending after a restart can tie with a later one, and a tie
 * would let the promoted row lose.
 *
 * Returns false when the item is not a pending visible row of the lane.
 */
export function promotePendingQueueItem(sessionKey: string, itemId: string): boolean {
  const db = initDb();
  return db.transaction(() => {
    const pending = db.prepare(
      "SELECT id, internal FROM queue_items WHERE session_key = ? AND status = 'pending' ORDER BY position ASC, created_at ASC, rowid ASC",
    ).all(sessionKey) as Array<{ id: string; internal: number }>;
    const visible = pending.filter((row) => row.internal === 0);
    if (!visible.some((row) => row.id === itemId)) return false;
    const promoted = rotatePendingToFront(visible, itemId);
    let nextVisible = 0;
    const write = db.prepare("UPDATE queue_items SET position = ? WHERE id = ? AND status = 'pending'");
    pending.forEach((row, index) => write.run(index + 1, row.internal === 0 ? promoted[nextVisible++].id : row.id));
    return true;
  }).immediate();
}

export function getQueueItems(sessionKey: string): QueueItem[] {
  const db = initDb();
  const rows = db.prepare(
    `${QUEUE_ITEM_SELECT} WHERE session_key = ? AND internal = 0 AND status IN ('pending', 'running') ORDER BY position ASC`
  ).all(sessionKey) as QueueItemRow[];
  return rows.map(rowToQueueItem);
}

/**
 * How many operator-visible turns each session key has parked, in one grouped
 * read. This is what the session list's queue badge shows, so it must agree with
 * `getQueueItems` rather than with the in-process promise chain, which only
 * shrinks when a cancelled row's slot is reached and skipped.
 */
export function countPendingQueueItemsByKey(): Map<string, number> {
  const db = initDb();
  const rows = db.prepare(
    "SELECT session_key AS sessionKey, COUNT(*) AS n FROM queue_items WHERE status = 'pending' AND internal = 0 GROUP BY session_key"
  ).all() as Array<{ sessionKey: string; n: number }>;
  return new Map(rows.map((row) => [row.sessionKey, row.n]));
}

/**
 * Clear a session's operator-visible queue: {@link withdrawPendingQueueItem} for
 * every parked row at once, so the cancels and the bubble deletes commit
 * together. Internal callback rows are left alone (they are not the operator's
 * to clear, and their messages are not operator bubbles).
 *
 * Returns the rows withdrawn, as they were read inside the transaction.
 */
export function withdrawAllPendingQueueItems(sessionKey: string): QueueItem[] {
  const db = initDb();
  return db.transaction(() => {
    const rows = db.prepare(
      `${QUEUE_ITEM_SELECT} WHERE session_key = ? AND internal = 0 AND status = 'pending'`
    ).all(sessionKey) as QueueItemRow[];
    const cancel = db.prepare("UPDATE queue_items SET status = 'cancelled' WHERE id = ? AND status = 'pending'");
    const drop = db.prepare('DELETE FROM messages WHERE id = ?');
    const items = rows.map(rowToQueueItem);
    for (const item of items) {
      cancel.run(item.id);
      if (item.messageId) drop.run(item.messageId);
    }
    return items;
  }).immediate();
}

export function recoverStaleQueueItems(): number {
  const db = initDb();
  // If the gateway restarts mid-run, move any "running" items back to "pending"
  // so they can be replayed. Do NOT cancel pending work.
  const result = db.prepare(
    `UPDATE queue_items
     SET status = 'pending', started_at = NULL
     WHERE status = 'running'
       AND NOT EXISTS (
         SELECT 1 FROM sessions
         WHERE sessions.id = queue_items.session_id
           AND sessions.workflow_kind IS NOT NULL
       )`
  ).run();
  return result.changes;
}

/**
 * The pending rows a session is waiting on, oldest first. A row here is a turn
 * that has been accepted for this session but has not started: paired with the
 * in-process queue's `hasInFlightItem`, it is how a sweep tells "parked behind
 * a long lane" from "running with nothing driving it".
 */
export function listPendingQueueItemIdsForSession(sessionId: string): string[] {
  const db = initDb();
  const rows = db.prepare(
    "SELECT id FROM queue_items WHERE session_id = ? AND status = 'pending' ORDER BY created_at ASC, position ASC"
  ).all(sessionId) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

/** The prompts of the turns a session is running right now. */
export function runningQueuePromptsForSession(sessionId: string): string[] {
  const db = initDb();
  const rows = db.prepare("SELECT prompt FROM queue_items WHERE session_id = ? AND status = 'running'").all(sessionId) as Array<{ prompt: string }>;
  return rows.map((row) => row.prompt);
}

/**
 * What a session's queued and running turns are carrying: their prompts, and
 * the ids of the logged messages they will answer, from their own rows and
 * from the callback deliveries batched into them.
 */
export function openTurnMessages(sessionId: string): { prompts: string[]; messageIds: Set<string> } {
  const db = initDb();
  const items = db.prepare(
    "SELECT id, prompt, message_id AS messageId, dispatch_payload FROM queue_items WHERE session_id = ? AND status IN ('pending', 'running')",
  ).all(sessionId) as Array<{ id: string; prompt: string; messageId: string | null; dispatch_payload: string | null }>;
  const messageIds = new Set(items.flatMap((item) => [
    ...(item.messageId ? [item.messageId] : []), ...(parseDispatchPayload(item.dispatch_payload)?.foldedMessageIds ?? [])]));
  if (items.length > 0) {
    const delivered = db.prepare(
      `SELECT message_id AS messageId FROM callback_deliveries WHERE message_id IS NOT NULL AND queue_item_id IN (${items.map(() => "?").join(", ")})`,
    ).all(...items.map((item) => item.id)) as Array<{ messageId: string }>;
    for (const { messageId } of delivered) messageIds.add(messageId);
  }
  return { prompts: items.map((item) => item.prompt), messageIds };
}

/** Every pending row, each lane's rows in the order its slots will claim them. */
export function listAllPendingQueueItems(): QueueItem[] {
  const db = initDb();
  const rows = db.prepare(
    `${QUEUE_ITEM_SELECT} WHERE status = 'pending' ORDER BY position ASC, created_at ASC`
  ).all() as QueueItemRow[];
  return rows.map(rowToQueueItem);
}

