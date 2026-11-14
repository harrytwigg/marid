import { scopedEngineRefusal } from '../sessions/scoped-engine.js';
import { OPERATOR_ASSIGNEE } from './operator-assignee.js';
import { departmentScope, scopeDepartmentOfItem } from './department-scope.js';
import { getWorkItem } from './store.js';

/**
 * Whether a Todo's engine override can ever run. A department-scoped employee's
 * sessions run only on claude (FR-026), and every delegation or wake of a Todo
 * applies its override to the session it starts, so a non-claude override that
 * a scoped employee is to run would be stored now and refused at every attempt
 * after.
 *
 * Who will run it decides. `employee` is who the attempt is for; when nobody is
 * named, the Todo's own assignee is. A named runner is judged alone, by
 * `scopedEngineRefusal`, word for word: an open employee may hold a scoped
 * department's Todo and its sessions are not claude-only, so its override runs.
 * Only a Todo with no runner at all (unassigned, or the operator's) is judged by
 * its department, since whoever picks it up from there may be a scoped member.
 */
export function scopedOverrideRefusal(workItemId: string, engine: string | null | undefined, employee?: string | null): string | null {
  if (!engine || engine === 'claude') return null;
  const item = getWorkItem(workItemId);
  if (!item) return null;
  const runner = employee === undefined ? item.assignee : employee;
  if (runner && runner !== OPERATOR_ASSIGNEE) return scopedEngineRefusal(runner, engine);
  const department = scopeDepartmentOfItem(item, getWorkItem);
  if (!department || departmentScope(department) === 'open') return null;
  return `Todo ${item.id} is in department "${department}", whose sessions run only on the claude engine, `
    + `so its engine override cannot be "${engine}". Name "claude" or no engine.`;
}
