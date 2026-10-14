import { scopedDepartmentOf } from "../work-items/department-scope.js";

/**
 * A department-scoped employee's sessions run only on claude (FR-026): the turn
 * gate in `turn/scoped-turn.ts` refuses every other engine. These are the same
 * rule asked at creation time, so a new session is never put on an engine whose
 * first turn is bound to be refused.
 */

/** Whether `employee` is confined to a department, so its sessions start on claude whatever the engine health says. */
export function runsOnlyOnClaude(employee: string | null | undefined): boolean {
  return scopedDepartmentOf(employee) !== null;
}

/** Why a new session of `employee` cannot start on `engine`, or null when it can. */
export function scopedEngineRefusal(employee: string | null | undefined, engine: string): string | null {
  const department = scopedDepartmentOf(employee);
  if (!department || engine === "claude") return null;
  return `employee "${employee}" is confined to department "${department}", whose sessions run only on the claude engine, `
    + `so it cannot start on "${engine}". Name "claude" or no engine (a Todo's own engine override counts as naming one).`;
}
