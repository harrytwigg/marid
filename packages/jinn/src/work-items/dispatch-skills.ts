import path from 'node:path';
import { SKILLS_DIR } from '../shared/paths.js';
import { installedSkillNames } from '../shared/skill-commands.js';
import { skillRefusal } from '../shared/skill-inspection.js';
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

/**
 * Why a skill cannot go into a scoped department's stage directory (it holds a symlink, say),
 * or null when it can. Read from disk each time: skills change while the gateway runs.
 */
function stageRefusal(name: string): string | null {
  return skillRefusal(path.join(SKILLS_DIR, name));
}

/**
 * The skills among `names` that `workItemId`'s department allows but cannot be given, each
 * with why. A Todo outside a scoped department has none: its sessions read `skills/` itself.
 */
export function refusedDepartmentSkills(workItemId: string, names: readonly string[]): Array<{ skill: string; reason: string }> {
  const allowed = allowListOf(workItemId);
  if (!allowed) return [];
  return names.flatMap((skill) => {
    const reason = allowed.includes(skill) ? stageRefusal(skill) : null;
    return reason ? [{ skill, reason }] : [];
  });
}

/** The skill names `workItemId` may request: the installed ones, narrowed to its department's allow-list and to the skills its stage directory can hold. */
export function offeredSkillNames(workItemId: string): Set<string> {
  const installed = installedSkillNames();
  const allowed = allowListOf(workItemId);
  return allowed ? new Set(allowed.filter((name) => installed.has(name) && !stageRefusal(name))) : installed;
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
