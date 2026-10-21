/**
 * Squashing a parked queue into one turn: what "send now" does to the messages
 * already waiting. Cutting the running turn off for them should not hand the
 * engine one message per turn, each answered before the next is read: the
 * operator sent them together, so the engine reads them together.
 *
 * Kept beside `queue-item-registry.ts`, which owns the row model, rather than in
 * it, which is at its size limit.
 */
import { initDb } from '../shared/db.js';
import { parseDispatchPayload, serializeDispatchPayload, type QueueDispatch } from './queue-dispatch.js';

interface MergeRow {
  id: string;
  prompt: string;
  position: number;
  message_id: string | null;
  dispatch_payload: string | null;
}

/** What one merged message's text is separated from the next by. */
export const MERGED_MESSAGE_SEPARATOR = "\n\n";

const PARKED_MESSAGES =
  "FROM queue_items WHERE session_key = ? AND status = 'pending' AND internal = 0 AND dispatch_payload IS NOT NULL";

/**
 * Fold every parked operator message of the lane into `intoId`, in the order
 * they would have run: one text joined by blank lines, every attachment, and
 * the speech note only if every one of them was spoken (on a typed message the
 * note would invite the engine to "correct" exact text). `intoId` takes the
 * earliest position among them, so it runs where the first of them would have,
 * and the others are cancelled. Their transcript bubbles stay: each message was
 * sent, and the turn that answers them all reads every one of them. The row
 * records their ids, so the turn is known to answer those messages too.
 *
 * The merged row is sent, not parked: it becomes internal, which takes it off
 * the operator's queue (no card, no edit, no cancel, not counted) while keeping
 * its place in the line, as a callback delivery's row does. Its bubbles cannot
 * be withdrawn from under a turn that is about to read them.
 *
 * Internal rows (callback deliveries) keep their place and are never folded in.
 * Nor is a row that recorded no dispatch payload: its files still live on its
 * dispatch closure, which folding would drop. `intoId` must have one itself.
 *
 * Returns the ids of the rows folded in, empty when there was nothing to fold.
 */
export function mergePendingQueueItems(sessionKey: string, intoId: string): string[] {
  const db = initDb();
  // Most interrupting sends have nothing parked: look before taking the write lock.
  if ((db.prepare(`SELECT COUNT(*) AS n ${PARKED_MESSAGES}`).get(sessionKey) as { n: number }).n < 2) return [];
  return db.transaction(() => {
    const rows = db.prepare(
      `SELECT id, prompt, position, message_id, dispatch_payload ${PARKED_MESSAGES} ORDER BY position ASC, created_at ASC, rowid ASC`,
    ).all(sessionKey) as MergeRow[];
    if (rows.length < 2 || !rows.some((row) => row.id === intoId)) return [];
    const dispatches = rows.map((row) => parseDispatchPayload(row.dispatch_payload)!);
    const folded = rows.filter((row) => row.id !== intoId);
    const dispatch: QueueDispatch = {
      attachments: [...new Set(dispatches.flatMap((parsed) => parsed.attachments))],
      speechDerived: dispatches.every((parsed) => parsed.speechDerived),
      foldedMessageIds: folded.flatMap((row) => (row.message_id ? [row.message_id] : [])),
    };
    db.prepare("UPDATE queue_items SET prompt = ?, dispatch_payload = ?, position = ?, internal = 1 WHERE id = ? AND status = 'pending'")
      .run(rows.map((row) => row.prompt).join(MERGED_MESSAGE_SEPARATOR), serializeDispatchPayload(dispatch), rows[0].position, intoId);
    const cancel = db.prepare("UPDATE queue_items SET status = 'cancelled' WHERE id = ? AND status = 'pending'");
    for (const row of folded) cancel.run(row.id);
    return folded.map((row) => row.id);
  }).immediate();
}
