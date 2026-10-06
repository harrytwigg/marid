import type { initDb } from '../shared/db.js';
import { DepartmentBoundaryError, employeeDepartment, holdRefusal, isNonOpenDepartment, LIVE_HOLD_LOOKUPS } from './department-scope.js';
import type { AppendWorkItemEventInput, UpdateWorkItemInput, WorkItem } from './store.js';

/**
 * FR-004 and FR-015 at the store's writers, so every caller of them is covered: the
 * operator's metadata pen, the internal update path, creates from any route, plugins
 * and cron, and assignment. A Todo's scope is its ROOT's department (FR-002).
 *
 * The rules, for a write that touches a non-open department:
 *   - a sub-task stays in its root's department (no move out of a non-open root, and
 *     none into a non-open department under another root);
 *   - moving a root takes along the sub-tasks that share its department, so the tree
 *     stays whole; a sub-task that already sits elsewhere would straddle the boundary,
 *     so that move is refused and the sub-task named;
 *   - a move never strands a holder: every open Todo in the tree must still be one its
 *     assignee may hold in the new department, or the move is refused naming them;
 *   - a new assignee must be one who may hold the Todo (`mayHoldTodo`).
 * Between open departments nothing changes.
 */

type Db = ReturnType<typeof initDb>;
type Append = (input: AppendWorkItemEventInput) => unknown;

interface TreeRow {
  id: string;
  department: string | null;
  assignee: string | null;
  status: string;
}

function where(department: string | null | undefined): string {
  return department ? `department "${department}"` : 'the company';
}

function rootDepartment(db: Db, item: WorkItem): string | null {
  if (item.rootId === item.id) return item.department;
  const root = db.prepare('SELECT department FROM work_items WHERE id = ?').get(item.rootId) as { department: string | null } | undefined;
  return root ? root.department : item.department;
}

/** Refuses `assignee` on a Todo whose root sits in `rootDept`. */
export function assertMayHold(assignee: string | null | undefined, todoId: string, rootDept: string | null | undefined): void {
  const why = holdRefusal(assignee, todoId, rootDept);
  if (why) throw new DepartmentBoundaryError(why, [{ todo: todoId, assignee: assignee! }]);
}

/** The create-time hold check: the new Todo's root is its parent's root, or itself. */
export function assertCreateMayHold(db: Db, parent: WorkItem | undefined, department: string | null, assignee: string | null | undefined): void {
  if (!assignee) return;
  assertMayHold(assignee, parent ? `a sub-task of ${parent.id}` : 'the new Todo', parent ? rootDepartment(db, parent) : department);
}

function subtaskMoveRefusal(item: WorkItem, rootDept: string | null, next: string | null): DepartmentBoundaryError | null {
  if (next === rootDept || (!isNonOpenDepartment(rootDept) && !isNonOpenDepartment(next))) return null;
  return new DepartmentBoundaryError(
    `${item.id} is a sub-task of ${item.rootId} in ${where(rootDept)}, and a sub-task shares its root's department while either is not open: it cannot move to ${where(next)}`,
  );
}

function strandedHolders(rows: readonly TreeRow[], next: string | null): Array<{ todo: string; assignee: string }> {
  return rows
    .filter((row) => row.status !== 'done' && row.status !== 'cancelled' && holdRefusal(row.assignee, row.id, next, LIVE_HOLD_LOOKUPS) !== null)
    .map((row) => ({ todo: row.id, assignee: row.assignee! }));
}

interface RootMove {
  cascade: string[];
  tree: string[];
  from: string | null;
  to: string | null;
}

function planRootMove(db: Db, item: WorkItem, next: string | null, assignee: string | null | undefined): RootMove {
  const from = item.department;
  const subtasks = db.prepare('SELECT id, department, assignee, status FROM work_items WHERE root_id = ? AND id != ?').all(item.id, item.id) as TreeRow[];
  const straddling = subtasks.filter((row) => row.department !== from && row.department !== next
    && (isNonOpenDepartment(row.department) || isNonOpenDepartment(next)));
  if (straddling.length > 0) {
    const named = straddling.map((row) => `${row.id} (${where(row.department)})`).join(', ');
    throw new DepartmentBoundaryError(`moving ${item.id} to ${where(next)} would leave sub-task(s) ${named} on the other side of a non-open department's boundary; a sub-task shares its root's department`);
  }
  const self: TreeRow = { id: item.id, department: from, assignee: assignee === undefined ? item.assignee : assignee, status: item.status };
  const stranded = strandedHolders([self, ...subtasks], next);
  if (stranded.length > 0) {
    const named = stranded.map((hold) => `${hold.todo} (held by ${hold.assignee})`).join(', ');
    throw new DepartmentBoundaryError(`moving ${item.id} to ${where(next)} would strand Todos whose holders may not hold them there: ${named}. Reassign them first`, stranded);
  }
  return { cascade: subtasks.filter((row) => row.department === from).map((row) => row.id), tree: [item.id, ...subtasks.map((row) => row.id)], from, to: next };
}

function applyRootMove(db: Db, move: RootMove, rootId: string, actor: string | null | undefined, append: Append): void {
  const now = new Date().toISOString();
  const update = db.prepare('UPDATE work_items SET department = ?, updated_at = ?, version = version + 1 WHERE id = ?');
  for (const id of move.cascade) {
    update.run(move.to, now, id);
    append({ workItemId: id, kind: 'note', actor: actor ?? null, detail: { updatedFields: ['department'], department: move.to, movedWithRoot: rootId }, versionEffect: 'companion' });
  }
  if (!isNonOpenDepartment(move.from) || move.from === move.to) return;
  // A scoped session working one of these Todos loses sight of it on its next call (the
  // gateway answers 404). The turn finishes; the Todo records that it left the department.
  const placeholders = move.tree.map(() => '?').join(', ');
  const working = db.prepare(`SELECT id, work_item_id FROM sessions WHERE scope_department = ? AND work_item_id IN (${placeholders})`)
    .all(move.from, ...move.tree) as Array<{ id: string; work_item_id: string }>;
  const byTodo = new Map<string, string[]>();
  for (const row of working) byTodo.set(row.work_item_id, [...(byTodo.get(row.work_item_id) ?? []), row.id]);
  for (const [todo, sessions] of byTodo) {
    append({ workItemId: todo, kind: 'escalated', actor: actor ?? null, detail: { reason: 'left-department', department: move.from, movedTo: move.to, sessions }, versionEffect: 'audit' });
  }
}

/**
 * Checks a metadata update against the department boundary, inside the writer's
 * transaction and before its own UPDATE, and moves a root's sub-tasks with it.
 * Throws {@link DepartmentBoundaryError}; the transaction then writes nothing.
 */
export function guardWorkItemUpdate(db: Db, current: WorkItem, input: UpdateWorkItemInput, actor: string | null | undefined, append: Append): void {
  let scopeDepartment = rootDepartment(db, current);
  const next = input.department;
  if (next !== undefined && next !== current.department) {
    if (current.rootId !== current.id) {
      const refusal = subtaskMoveRefusal(current, scopeDepartment, next);
      if (refusal) throw refusal;
    } else if (isNonOpenDepartment(current.department) || isNonOpenDepartment(next)) {
      applyRootMove(db, planRootMove(db, current, next, input.assignee), current.id, actor, append);
      scopeDepartment = next;
    } else {
      scopeDepartment = next;
    }
  }
  if (input.assignee !== undefined && input.assignee !== current.assignee) assertMayHold(input.assignee, current.id, scopeDepartment);
}

/** A system employee (the Dispatcher) runs a Todo's thread without holding it, and `system` is never scoped (FR-006). */
function holdsWhenExecuting(employee: string | null): employee is string {
  return !!employee && employeeDepartment(employee) !== 'system';
}

/**
 * FR-008 and FR-015 at the link, the backstop for every path that starts work on a
 * Todo: a session bound to a department links only to Todos in it, and a session
 * linked to execute a Todo must belong to an employee who may hold it.
 */
export function assertSessionMayLink(db: Db, sessionId: string, todoId: string, role: string): void {
  const session = db.prepare('SELECT employee, scope_department FROM sessions WHERE id = ?').get(sessionId) as
    { employee: string | null; scope_department: string | null } | undefined;
  const item = db.prepare('SELECT id, root_id, department FROM work_items WHERE id = ?').get(todoId) as
    { id: string; root_id: string; department: string | null } | undefined;
  if (!session || !item) return;
  const rootDept = rootDepartment(db, { id: item.id, rootId: item.root_id, department: item.department } as WorkItem);
  if (session.scope_department !== null && session.scope_department !== rootDept) {
    throw new DepartmentBoundaryError(`session ${sessionId} is bound to department "${session.scope_department}" and cannot be linked to ${todoId}, which is in ${where(rootDept)}`);
  }
  if (role === 'execute' && holdsWhenExecuting(session.employee)) assertMayHold(session.employee, todoId, rootDept);
}
