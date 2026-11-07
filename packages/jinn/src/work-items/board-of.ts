import { getWorkItem, type WorkItem } from './store.js';

/**
 * The board a Todo belongs to: its root's department, the rule the department scope uses. Null for the
 * company board (no department), which cannot be shared.
 */
export function boardOfTodo(item: Pick<WorkItem, 'id' | 'rootId' | 'department'>): string | null {
  if (item.rootId === item.id) return item.department;
  return getWorkItem(item.rootId)?.department ?? null;
}

/** The department a write may move a Todo's board out of: only a root's own department is its board's. */
export function departmentBefore(item: Pick<WorkItem, 'parentId' | 'department'>): string | null | undefined {
  return item.parentId === null ? item.department : undefined;
}
