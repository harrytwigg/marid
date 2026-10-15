import { scopedEngineRefusal } from '../sessions/scoped-engine.js';
import { departmentScope, scopeDepartmentOfItem } from './department-scope.js';
import { getWorkItem } from './store.js';

/**
 * Whether a Todo's engine override can ever run. A department-scoped employee's
 * sessions run only on claude (FR-026), and every delegation or wake of a Todo
 * applies its override to the session it starts, so a non-claude override on a
 * Todo in a scoped department, or held by (or aimed at) a scoped employee,
 * would be stored now and refused at every attempt after.
 *
 * `employee` is who the attempt is for; when nobody is named, the Todo's own
 * assignee is. The employee's own refusal is `scopedEngineRefusal`'s, word for
 * word; the department's is the same rule asked of the Todo.
 */
export function scopedOverrideRefusal(workItemId: string, engine: string | null | undefined, employee?: string | null): string | null {
  if (!engine || engine === 'claude') return null;
  const item = getWorkItem(workItemId);
  if (!item) return null;
  const own = scopedEngineRefusal(employee === undefined ? item.assignee : employee, engine);
  if (own) return own;
  const department = scopeDepartmentOfItem(item, getWorkItem);
  if (!department || departmentScope(department) === 'open') return null;
  return `Todo ${item.id} is in department "${department}", whose sessions run only on the claude engine, `
    + `so its engine override cannot be "${engine}". Name "claude" or no engine.`;
}
