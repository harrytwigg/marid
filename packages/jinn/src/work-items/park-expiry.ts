import { initDb } from '../shared/db.js';
import { logger } from '../shared/logger.js';
import { PARK_EXPIRY_ACTOR } from './event-log.js';
import { getWorkItem, type WorkItemStatus } from './store.js';
import { transition } from './transitions.js';

/**
 * The un-park half of parking.
 *
 * A park is a `blocked` Todo whose stop cause carries `parkedUntil` (PLA-157):
 * the board reads it as "waiting on a clock, not on you" and the needs-you
 * queue leaves it out. Until now nothing acted when that clock ran out. The
 * park simply stopped hiding the Todo, which then sat in `blocked` looking like
 * a question for a human — so every date-gated Todo needed somebody to remember
 * to come back and move it, and forgetting was silent.
 *
 * So the sweep does the move the park promised: once `parkedUntil` has passed,
 * the Todo goes back to the work queue the same way a `dependency` block does
 * (`blocks.ts`) — `assigned` if it has an owner, whose auto-start then picks it
 * up, and `backlog` if it has none, where the idle-capacity loop and the
 * operator can see it. The transition deletes the stop cause, as leaving
 * `blocked` always does, so a released park cannot be released twice.
 *
 * `escalated` is deliberately out of scope. It is sticky — a question put to
 * the operator — and a clock does not answer it; an expired park there only
 * stops hiding it, which is the right outcome.
 */

interface ParkedRow {
  id: string;
  parkedUntil: string;
}

/** Where an expired park resumes: the same queue a `dependency` block re-queues to. */
function resumeTarget(assignee: string | null): WorkItemStatus {
  return assignee ? 'assigned' : 'backlog';
}

/** Put one expired park back in the queue. False when it moved first, or the move was refused. */
function releaseOne(row: ParkedRow): boolean {
  const item = getWorkItem(row.id);
  if (!item || item.status !== 'blocked') return false;
  try {
    transition(row.id, resumeTarget(item.assignee), PARK_EXPIRY_ACTOR, {
      detail: { reason: 'park-expired', parkedUntil: row.parkedUntil },
    });
    return true;
  } catch (err) {
    // One Todo that will not move must not stop the rest, nor the reconcile tick this runs in.
    logger.warn(`Todo ${row.id} reached the end of its park but could not be re-queued: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

/**
 * One pass: re-queue every `blocked` Todo whose `parkedUntil` is at or before
 * `now`. Returns how many moved. A value that does not parse is left alone —
 * `isParked` already stops such a park hiding anything, and moving work on a
 * date nobody can read would be a guess. Exported for tests; the work-item
 * reconciler runs it at boot and on every tick.
 */
export function releaseExpiredParks(now: Date = new Date()): number {
  const rows = initDb()
    .prepare(
      `SELECT sc.work_item_id AS id, sc.parked_until AS parkedUntil
       FROM work_item_stop_cause sc JOIN work_items wi ON wi.id = sc.work_item_id
       WHERE wi.status = 'blocked' AND sc.parked_until IS NOT NULL`,
    )
    .all() as ParkedRow[];
  let released = 0;
  for (const row of rows) {
    const at = Date.parse(row.parkedUntil);
    if (Number.isNaN(at) || at > now.getTime()) continue;
    if (releaseOne(row)) released++;
  }
  return released;
}
