// What a stop does to the messages parked behind a session's turn. Split out of
// `queue-item-registry.ts`, which owns the rows and is at its size limit.
import { initDb } from "../shared/db.js";
import { cancelQueueItem, listPendingQueueItemIdsForSession, withdrawPendingQueueItem, type QueueItem } from "./queue-item-registry.js";
import { getSessionDeliveryByQueueItemId } from "./registry.js";

/**
 * Withdraw every message still parked for `sessionId`, bubbles and all, so that
 * nothing started by a later restart, config reload or slot claim can run it.
 * The in-memory lane is only a view of these rows: leaving one `pending` after a
 * stop is what let a replay wake the session again.
 *
 * A row an accepted callback or Todo delivery owns is cancelled too, so that a
 * replay cannot start it, but its message stays in the transcript: it is a
 * report the session was given, not a bubble nobody saw run.
 *
 * Returns the rows withdrawn with their bubbles, as read inside the transaction.
 */
export function withdrawPendingQueueItemsForStop(sessionId: string): QueueItem[] {
  return initDb().transaction(() => {
    const withdrawn: QueueItem[] = [];
    for (const itemId of listPendingQueueItemIdsForSession(sessionId)) {
      if (getSessionDeliveryByQueueItemId(itemId)) {
        cancelQueueItem(itemId);
        continue;
      }
      const item = withdrawPendingQueueItem(itemId);
      if (item) withdrawn.push(item);
    }
    return withdrawn;
  }).immediate();
}
