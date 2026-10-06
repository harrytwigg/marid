import { scopedDepartmentOf } from "../work-items/department-scope.js";

/** What the department of a session is worked out from: its binding, else its employee. */
export interface SessionView {
  employee?: string | null;
  scopeDepartment?: string | null;
}

/**
 * The department a session's cwd, transcript, prompt, gate and rate-limit handling belong to:
 * its binding, else its employee's scoped department. The one derivation; a session whose
 * binding was lost is still its scoped employee's.
 */
export function sessionScopeDepartment(session: SessionView | undefined): string | null {
  return session?.scopeDepartment ?? scopedDepartmentOf(session?.employee) ?? null;
}
