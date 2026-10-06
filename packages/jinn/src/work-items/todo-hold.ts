import { holdRefusal } from './department-scope.js';
import { getWorkItem, type WorkItem } from './store.js';

/**
 * FR-015 at the paths that start work without writing the assignee (the Dispatcher and
 * the board walk): why the Todo's current assignee may not hold it, or null. A holding
 * outside the rules only exists after a hand edit, and nothing should start on it.
 */
export function todoHoldRefusal(item: WorkItem): string | null {
  const root = item.rootId === item.id ? item : getWorkItem(item.rootId) ?? item;
  return holdRefusal(item.assignee, item.id, root.department);
}
