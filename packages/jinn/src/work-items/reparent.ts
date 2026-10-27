import { initDb } from '../shared/db.js';
import { holdRefusal, isNonOpenDepartment, LIVE_HOLD_LOOKUPS, DepartmentBoundaryError } from './department-scope.js';
import { parseTodoId } from './id.js';
import { holdLiveSignalsUntilCommit } from './live-events.js';
import type { WriteOrigin } from './origin.js';
import { addresseeOfParent } from './review-addressee.js';
import { appendWorkItemEvent, getWorkItem, type WorkItem } from './store.js';

/**
 * Changing a Todo's parent after creation, in either direction: set it to
 * another Todo (make a sub-task) or clear it (detach to a root). The Todo's own
 * sub-tasks move with it, and `root_id` and `depth` are recomputed for the whole
 * subtree in one transaction.
 *
 * Refused, with nothing written:
 *   - a parent that is the Todo itself or one of its descendants (a cycle);
 *   - a closed parent, as at create: the roll-up gate must not be violable;
 *   - a subtree that would end deeper than the sub-task cap;
 *   - a root that still holds a sprint (sub-tasks follow their root's sprint, so
 *     the sprint has to be cleared first rather than dropped silently);
 *   - a move that would put part of the subtree across a non-open department's
 *     boundary, or strand an assignee in a department they may not hold Todos in
 *     (the department of a Todo is never changed implicitly);
 *   - an `in_review` Todo going under a parent whose owner is an employee: its
 *     review would be addressed to an owner who has not been told.
 *
 * Review state needs no migration. A Todo's review addressee is computed from
 * its parent on read and never stored, so a detached Todo is the operator's to
 * review and a Todo made a sub-task is its new parent owner's, from this write on.
 */

export type ReparentErrorCode = 'not_found' | 'invalid' | 'conflict';

export class ReparentError extends Error {
  constructor(message: string, readonly code: ReparentErrorCode) {
    super(message);
    this.name = 'ReparentError';
  }
}

/** The sub-task depth cap (a root is depth 0). */
const MAX_DEPTH = 3;

interface TreeRow {
  id: string;
  parent_id: string | null;
  depth: number;
  department: string | null;
  assignee: string | null;
  status: string;
}

export interface ReparentResult {
  item: WorkItem;
  changed: boolean;
  /** Every Todo whose row moved: the Todo and its descendants. */
  moved: string[];
  /** The Todos whose children changed: the old and new parents. */
  parents: string[];
}

export interface ReparentOptions {
  actor?: string | null;
  origin?: WriteOrigin;
}

function isClosed(status: string): boolean {
  return status === 'done' || status === 'cancelled';
}

function where(department: string | null): string {
  return department ? `department "${department}"` : 'the company';
}

/** `item` and everything beneath it, found by walking parent links inside the
 *  old root's family (a root also holds sibling branches this must not touch). */
function subtreeOf(rows: readonly TreeRow[], itemId: string): TreeRow[] {
  const byParent = new Map<string, TreeRow[]>();
  for (const row of rows) {
    if (row.parent_id) byParent.set(row.parent_id, [...(byParent.get(row.parent_id) ?? []), row]);
  }
  const out: TreeRow[] = [];
  const self = rows.find((row) => row.id === itemId);
  const queue: TreeRow[] = self ? [self] : [];
  while (queue.length > 0) {
    const row = queue.shift()!;
    out.push(row);
    queue.push(...(byParent.get(row.id) ?? []));
  }
  return out;
}

/** Refuse a subtree that would straddle a non-open department boundary, or whose
 *  open holders may not hold Todos in the new root's department. */
function assertSubtreeFits(item: WorkItem, subtree: readonly TreeRow[], rootDepartment: string | null, rootId: string): void {
  const straddling = subtree.filter((row) => row.department !== rootDepartment
    && (isNonOpenDepartment(row.department) || isNonOpenDepartment(rootDepartment)));
  if (straddling.length > 0) {
    const named = straddling.map((row) => `${row.id} (${where(row.department)})`).join(', ');
    throw new DepartmentBoundaryError(
      `${item.id} cannot join ${rootId} in ${where(rootDepartment)}: ${named} would sit across a non-open department's boundary. Move them into ${where(rootDepartment)} first`,
    );
  }
  const stranded = subtree
    .filter((row) => row.assignee && !isClosed(row.status) && holdRefusal(row.assignee, row.id, rootDepartment, LIVE_HOLD_LOOKUPS) !== null)
    .map((row) => ({ todo: row.id, assignee: row.assignee! }));
  if (stranded.length > 0) {
    const named = stranded.map((hold) => `${hold.todo} (held by ${hold.assignee})`).join(', ');
    throw new DepartmentBoundaryError(`${item.id} cannot join ${rootId} in ${where(rootDepartment)}: ${named} may not hold Todos there. Reassign them first`, stranded);
  }
}

function assertNoCycle(item: WorkItem, subtree: readonly TreeRow[], parent: WorkItem): void {
  if (!subtree.some((row) => row.id === parent.id)) return;
  throw new ReparentError(
    parent.id === item.id ? `${item.id} cannot be its own parent` : `${item.id} cannot become a sub-task of ${parent.id}, which is already beneath it`,
    'invalid',
  );
}

function assertParentOpen(parent: WorkItem): void {
  if (isClosed(parent.status)) {
    throw new ReparentError(`parent Todo ${parent.id} is ${parent.status} — sub-tasks cannot be added under a closed Todo`, 'invalid');
  }
}

function assertDepthFits(item: WorkItem, subtree: readonly TreeRow[], parent: WorkItem | undefined, shift: number): void {
  const deepest = Math.max(...subtree.map((row) => row.depth)) + shift;
  if (deepest > MAX_DEPTH) {
    throw new ReparentError(`moving ${item.id} under ${parent?.id} would put a sub-task at depth ${deepest} — the sub-task tree is capped at depth ${MAX_DEPTH}`, 'invalid');
  }
}

function assertNoSprint(db: ReturnType<typeof initDb>, item: WorkItem): void {
  if (item.parentId !== null) return;
  if (db.prepare('SELECT 1 FROM work_item_sprints WHERE work_item_id = ?').get(item.id)) {
    throw new ReparentError(`${item.id} is in a sprint, and sub-tasks follow their top-level Todo; take it out of its sprint first`, 'invalid');
  }
}

function assertReviewReachesOwner(item: WorkItem, parent: WorkItem): void {
  if (item.status !== 'in_review') return;
  const next = addresseeOfParent(parent);
  if (next.kind !== 'employee') return;
  const current = addresseeOfParent(item.parentId ? getWorkItem(item.parentId) : undefined);
  if (current.kind === 'employee' && current.employee === next.employee) return;
  throw new ReparentError(
    `${item.id} is in review and ${parent.id} is worked by ${next.employee}, who would not be told: move ${item.id} back to executing, or detach it again, first`,
    'invalid',
  );
}

interface Plan {
  subtree: TreeRow[];
  parent: WorkItem | undefined;
  newRootId: string;
  newDepth: number;
  shift: number;
}

/** Every refusal, in one place, before anything is written. */
function planReparent(db: ReturnType<typeof initDb>, item: WorkItem, parent: WorkItem | undefined): Plan {
  const family = db.prepare('SELECT id, parent_id, depth, department, assignee, status FROM work_items WHERE root_id = ?')
    .all(item.rootId) as TreeRow[];
  const subtree = subtreeOf(family, item.id);
  const newDepth = parent ? parent.depth + 1 : 0;
  const shift = newDepth - item.depth;
  if (parent) {
    assertNoCycle(item, subtree, parent);
    assertParentOpen(parent);
    assertDepthFits(item, subtree, parent, shift);
    assertNoSprint(db, item);
    const newRoot = parent.rootId === parent.id ? parent : getWorkItem(parent.rootId) ?? parent;
    assertSubtreeFits(item, subtree, newRoot.department, parent.rootId);
    assertReviewReachesOwner(item, parent);
  }
  return { subtree, parent, newRootId: parent ? parent.rootId : item.id, newDepth, shift };
}

/** The audit trail: the Todo, each Todo that moved with it, and both parents. */
function recordReparent(item: WorkItem, plan: Plan, options: ReparentOptions): string[] {
  const actor = options.actor ?? null;
  const newParentId = plan.parent?.id ?? null;
  const moved = plan.subtree.filter((row) => row.id !== item.id).map((row) => row.id);
  appendWorkItemEvent({
    workItemId: item.id,
    kind: 'note',
    actor,
    detail: {
      reparented: { from: item.parentId, to: newParentId, rootFrom: item.rootId, rootTo: plan.newRootId, depth: plan.newDepth },
      ...(moved.length > 0 ? { movedWith: moved } : {}),
      ...(options.origin ? { origin: options.origin } : {}),
    },
    versionEffect: 'companion',
  });
  for (const id of moved) {
    appendWorkItemEvent({ workItemId: id, kind: 'note', actor, detail: { reparented: { with: item.id, rootFrom: item.rootId, rootTo: plan.newRootId } }, versionEffect: 'companion' });
  }
  // The old and new parents gain or lose a child, so tree views resort.
  const parents = [item.parentId, newParentId].filter((p): p is string => p !== null);
  for (const parentId of parents) {
    appendWorkItemEvent({
      workItemId: parentId,
      kind: 'note',
      actor,
      detail: { childReparented: { child: item.id, from: item.parentId, to: newParentId } },
      versionEffect: 'state',
    });
  }
  return parents;
}

/**
 * Set `workItemId`'s parent to `parentId`, or clear it with null. A call that
 * changes nothing writes nothing.
 */
export function reparentWorkItem(workItemId: string, parentId: string | null, options: ReparentOptions = {}): ReparentResult {
  const db = initDb();
  const id = parseTodoId(workItemId);
  const newParentId = parentId === null ? null : parseTodoId(parentId);
  const txn = db.transaction((): ReparentResult => {
    const item = getWorkItem(id);
    if (!item) throw new ReparentError(`Todo ${id} not found`, 'not_found');
    if ((item.parentId ?? null) === newParentId) return { item, changed: false, moved: [], parents: [] };
    const parent = newParentId === null ? undefined : getWorkItem(newParentId);
    if (newParentId !== null && !parent) throw new ReparentError(`parent Todo ${newParentId} not found`, 'not_found');

    const plan = planReparent(db, item, parent);
    const now = new Date().toISOString();
    const update = db.prepare('UPDATE work_items SET parent_id = ?, root_id = ?, depth = ?, updated_at = ?, version = version + 1 WHERE id = ?');
    for (const row of plan.subtree) {
      update.run(row.id === id ? newParentId : row.parent_id, plan.newRootId, row.depth + plan.shift, now, row.id);
    }
    const parents = recordReparent(item, plan, options);
    return { item: getWorkItem(id)!, changed: true, moved: plan.subtree.map((row) => row.id), parents };
  });
  return holdLiveSignalsUntilCommit(() => txn.immediate());
}
