import { scopedDepartmentOf } from "../work-items/department-scope.js";
import { sessionScopeDepartment, type SessionView } from "./session-scope.js";

/**
 * A department-scoped employee's sessions run only on claude (FR-026): the turn
 * gate in `turn/scoped-turn.ts` refuses every other engine. These are the same
 * rule asked up front: at creation, so a new session is never put on an engine whose
 * first turn is bound to be refused, and on a mid-chat engine switch, so an existing
 * session is never moved onto one.
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

/**
 * Why an existing session cannot be switched to `engine`, or null when it can. The department is
 * the turn gate's own answer (`sessionScopeDepartment`: the session's binding, else its employee's
 * department), so the switch is refused exactly when the next turn would be. Switching to claude
 * is always allowed, which is how a session stranded on another engine gets back.
 */
export function scopedSwitchRefusal(session: SessionView, engine: string): string | null {
  const department = sessionScopeDepartment(session);
  if (!department || engine === "claude") return null;
  return `this session is confined to department "${department}", whose sessions run only on the claude engine, `
    + `so it cannot switch to "${engine}".`;
}
