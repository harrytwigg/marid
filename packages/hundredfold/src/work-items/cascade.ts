import type { Database } from 'better-sqlite3';
import { initDb } from '../shared/db.js';
import type { WorkItem, WorkItemStatus } from './store.js';
import { transition } from './transitions.js';

/**
 * Closing a Todo TREE — the half of a cascade that is the same whichever
 * terminal it heads for, plus the close-specific rule that is not.
 *
 * Both callers run the sweep inside their own transaction, so the roll-up gate
 * in `transitions.ts` is already satisfied by the time the container itself
 * moves, and a refusal anywhere leaves the whole tree untouched:
 * `archiveWorkItem` cancels the descendants, `transition(…, 'done')` closes them.
 *
 * The import of `transition` is circular by design — `transitions.ts` reaches
 * back here for the close. Nothing on either side runs at module scope, so both
 * bindings are live by the time a cascade actually runs.
 */

/** An open descendant a cascade is about to close or cancel. */
export interface CascadeRow {
  id: string;
  status: WorkItemStatus;
  depth: number;
}

/** True when `candidateId` sits under `ancestorId` following parent links. The
 *  hop bound is the sub-task depth cap: anything further is not in this family,
 *  whatever `root_id` says. */
function isDescendantOf(candidateId: string, ancestorId: string): boolean {
  const db = initDb();
  let cursor: string | null = candidateId;
  for (let hops = 0; cursor && hops <= 3; hops++) {
    const row = db.prepare('SELECT parent_id FROM work_items WHERE id = ?').get(cursor) as { parent_id: string | null } | undefined;
    if (!row) return false;
    if (row.parent_id === ancestorId) return true;
    cursor = row.parent_id;
  }
  return false;
}

/** Every still-open descendant of `item`, deepest first. The indexed `root_id`
 *  sweep does the coarse work and the parent walk narrows it to this branch,
 *  because a root holds sibling branches this cascade must not touch. */
export function openDescendantsDeepestFirst(db: Database, item: WorkItem): CascadeRow[] {
  return (db
    .prepare("SELECT id, status, depth FROM work_items WHERE root_id = ? AND id != ? AND status NOT IN ('done', 'cancelled')")
    .all(item.rootId, item.id) as CascadeRow[])
    .filter((row) => isDescendantOf(row.id, item.id))
    .sort((a, b) => b.depth - a.depth);
}

/** Close every open descendant of `item` as `done`, deepest first. */
export function cascadeCloseDescendants(db: Database, item: WorkItem, actor: string): void {
  for (const descendant of openDescendantsDeepestFirst(db, item)) {
    transition(descendant.id, 'done', actor, { human: true, detail: { cascadeFrom: item.id } });
  }
}
