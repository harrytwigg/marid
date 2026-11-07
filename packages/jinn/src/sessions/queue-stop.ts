// What a stop does to the messages parked behind a session's turn. Split out of
// `queue-item-registry.ts`, which owns the rows and is at its size limit.
import { initDb } from "../shared/db.js";
import { listPendingQueueItemIdsForSession, withdrawPendingQueueItem, type QueueItem } from "./queue-item-registry.js";
import { getSessionDeliveryByQueueItemId } from "./registry.js";

/**
 * Withdraw every message still parked for `sessionId`, bubbles and all, so that
 * nothing started by a later restart, config reload or slot claim can run it.
 * The in-memory lane is only a view of these rows: leaving one `pending` after a
 * stop is what let a replay wake the session again.
 *
 * Accepted callback deliveries are left alone. Their acceptance was committed to
 * a durable outbox, and dropping them would lose a child's report rather than a
 * message somebody sent to this session.
 *
 * Returns the rows withdrawn, as they were read inside the transaction.
 */
export function withdrawPendingQueueItemsForStop(sessionId: string): QueueItem[] {
  return initDb().transaction(() => {
    const withdrawn: QueueItem[] = [];
    for (const itemId of listPendingQueueItemIdsForSession(sessionId)) {
      if (getSessionDeliveryByQueueItemId(itemId)) continue;
      const item = withdrawPendingQueueItem(itemId);
      if (item) withdrawn.push(item);
    }
    return withdrawn;
  }).immediate();
}
