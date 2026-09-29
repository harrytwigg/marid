import type { Database as DatabaseType } from 'better-sqlite3';
import { readStopCause, writeStopCause, type TodoStopCause } from './stop-cause.js';
import { appendWorkItemEvent, getWorkItem, type WorkItem, type WorkItemEvent } from './store.js';

/**
 * Restating a stop with a new cause — pushing a park's date out, naming who
 * unblocks it — moves nothing, but it is not nothing either. `transition()`'s
 * same-status shortcut used to swallow it, so a re-park answered success and
 * kept the old date. These two are what that shortcut does instead.
 *
 * Both run inside `transition()`'s transaction, on its `db`; they are their own
 * module only so the status write path stays one screen long.
 */

/** One comparable string per cause, so "the same cause" is one equality. */
function causeKey({ parkedUntil, unblockHint }: TodoStopCause = {}): string {
  return JSON.stringify([parkedUntil ?? null, unblockHint ? [unblockHint.what, unblockHint.who] : null]);
}

/** The cause the Todo would carry after this restatement — what the caller did
 *  not restate is kept, so a new date does not erase who unblocks it — or
 *  undefined when that is what it already carries. A retried block or
 *  escalation stays the no-op it always was. */
export function changedStopCause(db: DatabaseType, workItemId: string, cause: TodoStopCause): TodoStopCause | undefined {
  const current = readStopCause(db, workItemId);
  const merged = { ...current, ...cause };
  return causeKey(current) === causeKey(merged) ? undefined : merged;
}

/** Store the changed cause and write it down as a note, so the board and the
 *  audit trail both show the park moved. No `fromStatus`: nothing transitioned,
 *  so a status trigger has nothing to fire on. */
export function restateStopCause(
  db: DatabaseType,
  item: WorkItem,
  { merged, stated, actor, detail }: { merged: TodoStopCause; stated: TodoStopCause; actor: string; detail?: Record<string, unknown> },
): { item: WorkItem; escalated: false; event: WorkItemEvent } {
  writeStopCause(db, item.id, merged, new Date().toISOString());
  const event = appendWorkItemEvent({
    workItemId: item.id,
    kind: 'note',
    toStatus: item.status,
    actor,
    detail: { ...(detail ?? {}), ...stated },
    versionEffect: 'state',
  });
  return { item: getWorkItem(item.id)!, escalated: false, event };
}
