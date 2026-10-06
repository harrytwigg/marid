import path from "node:path";
import type { DepartmentScope } from "../work-items/department-scope.js";

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
  field: unknown,
  scopeOf: (slug: string) => DepartmentScope,
): string | null {
  const parts = path.relative(orgDir, fullPath).split(path.sep);
  const top = parts.length > 1 ? parts[0] : "org";
  const immediate = parts.length > 1 ? parts[parts.length - 2] : "org";
  const named = typeof field === "string" && field.trim() ? field.trim() : immediate;
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
