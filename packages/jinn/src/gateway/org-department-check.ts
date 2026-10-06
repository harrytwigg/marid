import path from "node:path";
import type { DepartmentScope } from "../work-items/department-scope.js";
import type { RemoteExecutionConfig } from "../shared/config-types.js";
import { scopedRemoteTargetProblem } from "../shared/remote-department.js";

/**
 * An employee's department: its `department` field, normalised to trimmed text, else its
 * directory's name. One value feeds both the FR-007 check and the roster, so a padded or
 * non-text field cannot read as one department to the check and another to the roster.
 */
export function resolveEmployeeDepartment(field: unknown, directory: string): string {
  // A falsy value (absent, empty, `false`, `0`) falls back to the directory, as it always has.
  if (!field) return directory;
  return String(field).trim() || directory;
}

/**
 * FR-007: scope is read from the top-level directory under `org/`. When that
 * directory, the immediate directory and the `department` field are not the same
 * department and any of them is not open, the employee is refused. A file straight
 * under `org/` belongs to the `org` department, as it resolves today. Returns why
 * the employee is refused, or null.
 */
export function departmentDisagreement(
  orgDir: string,
  fullPath: string,
  department: string,
  scopeOf: (slug: string) => DepartmentScope,
): string | null {
  const parts = path.relative(orgDir, fullPath).split(path.sep);
  const top = parts.length > 1 ? parts[0] : "org";
  const immediate = parts.length > 1 ? parts[parts.length - 2] : "org";
  const named = department;
  if (top === immediate && immediate === named) return null;
  const where = [...new Set([top, immediate, named])];
  const nonOpen = where.filter((slug) => scopeOf(slug) !== "open");
  if (nonOpen.length === 0) return null;
  return `its top-level directory "${top}", its directory "${immediate}" and its department field "${named}" disagree, and "${nonOpen.join('", "')}" is not an open department`;
}

/**
 * Why an employee's `department` cannot be changed to `next`, or null when it can.
 * The field has to agree with the directory the file sits in (FR-007), and the API
 * edits the field, not the file's place. So a change into or out of a department that
 * is not open would leave the employee refused at the next scan; that move is made by
 * hand, by moving the file.
 */
export function departmentChangeRefusal(
  name: string,
  current: string,
  next: string | undefined,
  scopeOf: (slug: string) => DepartmentScope,
): string | null {
  if (next === undefined || next === current) return null;
  const guarded = [current, next].filter((slug) => scopeOf(slug) !== "open");
  if (guarded.length === 0) return null;
  return `${name} cannot be moved between "${current}" and "${next}" through the API because "${guarded[0]}" is not an open department: its file must sit under org/${guarded[0]} and say so; move the file by hand`;
}

/**
 * FR-026: a department-scoped employee runs on the claude engine in v1, because the
 * department's stage directory uses Claude's layout. It may run on a remote host, where
 * its work area (its `remoteCwd`) must stay clear of the department stage directories and
 * of the mounted gateway home (FR-061). Returns why the employee is refused, or null.
 */
export function scopedEmployeeRefusal(
  employee: { department: string; engine?: string; remoteHost?: string; remoteCwd?: string },
  scopeOf: (slug: string) => DepartmentScope,
  remote: RemoteExecutionConfig | undefined,
): string | null {
  if (scopeOf(employee.department) === "open") return null;
  if ((employee.engine ?? "claude") !== "claude") {
    return `it is in non-open department "${employee.department}", whose employees must use the claude engine (the department's working directory uses Claude's layout), not "${employee.engine}"`;
  }
  const remoteProblem = employee.remoteHost ? scopedRemoteTargetProblem(employee.remoteCwd, remote) : null;
  return remoteProblem ? `it is in non-open department "${employee.department}" and runs on remote host "${employee.remoteHost}", but ${remoteProblem}` : null;
}
