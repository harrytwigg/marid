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

interface MergeRow {
  id: string;
  prompt: string;
  position: number;
  dispatch_payload: string | null;
}

/** What one merged message's text is separated from the next by. */
export const MERGED_MESSAGE_SEPARATOR = "\n\n";

/**
 * Fold every parked operator-visible row of the lane into `intoId`, in the
 * order they would have run: one text joined by blank lines, every attachment,
 * and the speech note if any of them was spoken. `intoId` takes the earliest
 * position among them, so it runs where the first of them would have, and the
 * others are cancelled. Their transcript bubbles stay: each message was sent,
 * and the turn that answers them all reads every one of them.
 *
 * Internal rows (callback deliveries) keep their place and are never folded in.
 * Nor is a row that recorded no dispatch payload: its files still live on its
 * dispatch closure, which folding would drop. `intoId` must have one itself.
 *
 * Returns the ids of the rows folded in, empty when there was nothing to fold.
 */
export function mergePendingQueueItems(sessionKey: string, intoId: string): string[] {
  const db = initDb();
  return db.transaction(() => {
    const rows = (db.prepare(
      "SELECT id, prompt, position, dispatch_payload FROM queue_items WHERE session_key = ? AND status = 'pending' AND internal = 0 ORDER BY position ASC, created_at ASC, rowid ASC",
    ).all(sessionKey) as MergeRow[]).filter((row) => row.dispatch_payload !== null);
    if (rows.length < 2 || !rows.some((row) => row.id === intoId)) return [];
    const dispatches = rows.map((row) => JSON.parse(row.dispatch_payload!) as { attachments?: string[]; speechDerived?: boolean });
    const dispatch = {
      attachments: [...new Set(dispatches.flatMap((parsed) => parsed.attachments ?? []))],
      speechDerived: dispatches.some((parsed) => parsed.speechDerived === true),
    };
    db.prepare("UPDATE queue_items SET prompt = ?, dispatch_payload = ?, position = ? WHERE id = ? AND status = 'pending'")
      .run(rows.map((row) => row.prompt).join(MERGED_MESSAGE_SEPARATOR), JSON.stringify(dispatch), rows[0].position, intoId);
    const cancel = db.prepare("UPDATE queue_items SET status = 'cancelled' WHERE id = ? AND status = 'pending'");
    const folded = rows.filter((row) => row.id !== intoId);
    for (const row of folded) cancel.run(row.id);
    return folded.map((row) => row.id);
  }).immediate();
}
