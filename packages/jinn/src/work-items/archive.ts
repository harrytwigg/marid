import { initDb } from '../shared/db.js';
import { openDescendantsDeepestFirst } from './cascade.js';
import { getWorkItem, type WorkItem } from './store.js';
import { transition } from './transitions.js';

export interface ArchiveWorkItemOptions {
  human?: boolean;
  callerSessionId?: string;
  note?: string;
  /** Cancel every open descendant first (depth-first), each with its own audited
   *  transition. Honored only together with `human: true` (operator authority). */
  cascade?: boolean;
}

/**
 * Cancel a Todo. Callers are authority-checked by the gateway before reaching
 * this persistence primitive. With `cascade` (human authority only), open
 * descendants are cancelled first, deepest first, so the roll-up gate stays
 * satisfied.
 */
export function archiveWorkItem(id: string, actor: string, opts: ArchiveWorkItemOptions = {}): WorkItem {
  const db = initDb();
  const txn = db.transaction((): WorkItem => {
    const item = getWorkItem(id);
    if (!item) throw new Error(`archiveWorkItem: work item ${id} not found`);
    if (item.status === 'cancelled') return item;
    if (opts.cascade && opts.human) {
      for (const descendant of openDescendantsDeepestFirst(db, item)) {
        transition(descendant.id, 'cancelled', actor, {
          human: true,
          detail: { ...(opts.note ? { note: opts.note } : {}), cascadeFrom: item.id },
        });
      }
    }
    return transition(id, 'cancelled', actor, {
      ...(opts.human ? { human: true } : {}),
      ...(opts.callerSessionId ? { callerSessionId: opts.callerSessionId } : {}),
      detail: { action: 'archive', ...(opts.note ? { note: opts.note } : {}) },
    }).item;
  });
  return txn();
}
