// Row model and queries for the queue_items table — the durable per-session
// turn queue. Split out of `registry.ts`, which owns the sessions and messages
// side of the same database; the table's DDL lives in `queue-items-schema.ts`.
import { randomUUID } from 'node:crypto';
import { initDb } from '../shared/db.js';

export interface QueueItem {
  id: string;
  sessionId: string;
  sessionKey: string;
  prompt: string;
  status: "pending" | "running" | "cancelled" | "completed";
  internal: boolean;
  /** The transcript row this item will run, when the enqueuing path had one. */
  messageId: string | null;
  /** Engine-facing extras that must travel with the payload when rows rotate.
   *  Null means this row never recorded any: the dispatch closure still decides. */
  dispatch: QueueDispatch | null;
  position: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

/** What a turn runs on besides its text. */
export interface QueueDispatch {
  attachments: string[];
  speechDerived: boolean;
}

interface QueueItemRow extends Omit<QueueItem, "internal" | "dispatch"> {
  internal: number;
  dispatch_payload: string | null;
}

/**
 * Null and empty are NOT the same thing here, and conflating them drops files.
 * Null means no payload was ever recorded for this row - the notification,
 * workflow and plugin paths never record one - so the dispatch closure still
 * decides. An empty recorded payload means "this row runs with nothing extra",
 * which is what a rotated row that carried no attachment must say, or it would
 * inherit the attachment of the row it landed on.
 */
function parseDispatchPayload(raw: string | null): QueueDispatch | null {
  if (raw === null) return null;
  const parsed = JSON.parse(raw) as { attachments?: string[]; speechDerived?: boolean };
  return { attachments: parsed.attachments ?? [], speechDerived: parsed.speechDerived === true };
}

function serializeDispatchPayload(dispatch: QueueDispatch | null): string | null {
  return dispatch === null ? null : JSON.stringify(dispatch);
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
 * Move payloads between parked rows, in one transaction so a reader never sees
 * two rows claiming the same message. The rows keep their positions and their
 * place in the committed promise chain; only what they will run changes.
 *
 * The whole payload moves - text, bubble, attachments, speech origin - because a
 * message arriving with a neighbour's attachment is worse than not reordering.
 */
export function reassignPendingQueuePayloads(
  assignments: ReadonlyArray<{ id: string; payload: QueueItem }>,
): void {
  const db = initDb();
  db.transaction(() => {
    const write = db.prepare(
      "UPDATE queue_items SET prompt = ?, message_id = ?, dispatch_payload = ? WHERE id = ? AND status = 'pending'",
    );
    for (const { id, payload } of assignments) {
      // Always explicit after a rotation, never null: a promoted row that says
      // nothing would fall back to the closure of the row it displaced.
      const dispatch = payload.dispatch ?? { attachments: [], speechDerived: false };
      write.run(payload.prompt, payload.messageId, serializeDispatchPayload(dispatch), id);
    }
  }).immediate();
}

export function getQueueItems(sessionKey: string): QueueItem[] {
  const db = initDb();
  const rows = db.prepare(
    `${QUEUE_ITEM_SELECT} WHERE session_key = ? AND internal = 0 AND status IN ('pending', 'running') ORDER BY position ASC`
  ).all(sessionKey) as QueueItemRow[];
  return rows.map(rowToQueueItem);
}

export function cancelAllPendingQueueItems(sessionKey: string): number {
  const db = initDb();
  const result = db.prepare(
    "UPDATE queue_items SET status = 'cancelled' WHERE session_key = ? AND internal = 0 AND status = 'pending'"
  ).run(sessionKey);
  return result.changes;
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

/**
 * What a session's queued and running turns are carrying: their prompts, and
 * the ids of the logged messages they will answer, from their own rows and
 * from the callback deliveries batched into them.
 */
export function openTurnMessages(sessionId: string): { prompts: string[]; messageIds: Set<string> } {
  const db = initDb();
  const items = db.prepare(
    "SELECT id, prompt, message_id AS messageId FROM queue_items WHERE session_id = ? AND status IN ('pending', 'running')",
  ).all(sessionId) as Array<{ id: string; prompt: string; messageId: string | null }>;
  const messageIds = new Set(items.flatMap((item) => (item.messageId ? [item.messageId] : [])));
  if (items.length > 0) {
    const delivered = db.prepare(
      `SELECT message_id AS messageId FROM callback_deliveries WHERE message_id IS NOT NULL AND queue_item_id IN (${items.map(() => "?").join(", ")})`,
    ).all(...items.map((item) => item.id)) as Array<{ messageId: string }>;
    for (const { messageId } of delivered) messageIds.add(messageId);
  }
  return { prompts: items.map((item) => item.prompt), messageIds };
}

export function listAllPendingQueueItems(): QueueItem[] {
  const db = initDb();
  const rows = db.prepare(
    `${QUEUE_ITEM_SELECT} WHERE status = 'pending' ORDER BY created_at ASC, position ASC`
  ).all() as QueueItemRow[];
  return rows.map(rowToQueueItem);
}

