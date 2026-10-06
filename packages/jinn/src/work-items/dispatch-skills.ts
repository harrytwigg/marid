import { installedSkillNames } from '../shared/skill-commands.js';
import { departmentSkillAllowList, scopedDepartmentOf, scopeDepartmentOfItem } from './department-scope.js';
import { getWorkItem } from './store.js';

/**
 * Which skills a Todo may preload (FR-027). A Todo whose root sits in a department that
 * is not open can request only the skills that department allows; every other Todo may
 * request any installed skill, as before.
 */

function allowListOf(workItemId: string): readonly string[] | null {
  const item = getWorkItem(workItemId);
  return item ? departmentSkillAllowList(scopeDepartmentOfItem(item, getWorkItem)) : null;
}

/** The skill names `workItemId` may request: the installed ones, narrowed to its department's allow-list. */
export function offeredSkillNames(workItemId: string): Set<string> {
  const installed = installedSkillNames();
  const allowed = allowListOf(workItemId);
  return allowed ? new Set(allowed.filter((name) => installed.has(name))) : installed;
}

/** A sentence for a refusal that says which skills the Todo's department offers; empty when it is not restricted. */
export function skillAllowListNote(workItemId: string): string {
  const allowed = allowListOf(workItemId);
  if (!allowed) return '';
  return ` — this Todo's department offers ${allowed.length > 0 ? `only: ${allowed.join(', ')}` : 'no skills'}`;
}

/**
 * Where the skills are read from in the prompt. A department-scoped employee runs in its
 * stage directory, where the allowed skills are copied to `.claude/skills/`; anyone else
 * reads `skills/` in the Jinn home. `employee` is who the session is for: a delegation
 * resolves its brief before the Todo changes hands, so the Todo's current assignee is only
 * the answer when nobody is named.
 */
export function skillsRootFor(workItemId: string, employee?: string | null): string {
  const runner = employee === undefined ? getWorkItem(workItemId)?.assignee : employee;
  return scopedDepartmentOf(runner) ? '.claude/skills' : 'skills';
}
