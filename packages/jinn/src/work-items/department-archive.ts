import type { Database as DatabaseType } from "better-sqlite3";
import { resolveDepartmentPrefix } from "./departments.js";

/**
 * Archived departments. An archived department takes no new Todos — not created in it,
 * not moved into it — and drops out of every picker, but nothing in it changes: its
 * Todos keep their ids and stay readable, searchable and editable, and its registry row
 * stays, so its prefix can never be handed to another department.
 */

export class DepartmentArchivedError extends Error {
  readonly code = "department-archived";
  constructor(readonly department: string) {
    super(`department "${department}" is archived and takes no new Todos: un-archive it first, or file this Todo in another department`);
    this.name = "DepartmentArchivedError";
  }
}

export function isDepartmentArchived(db: DatabaseType, department: string | null | undefined): boolean {
  if (!department) return false;
  return !!db.prepare("SELECT 1 FROM department_archives WHERE slug = ?").get(department);
}

/** The configured default department, unless it has been archived since. An archived
 *  default is no default: a create or an assignment that would have filled it leaves the
 *  Todo unclassified instead, so config set after an archive cannot make every
 *  department-less create fail. */
export function usableDefaultDepartment(db: DatabaseType, defaultDepartment: string | null | undefined): string | null {
  return defaultDepartment && !isDepartmentArchived(db, defaultDepartment) ? defaultDepartment : null;
}

/** Refuse a write that would put a Todo into an archived department. */
export function assertDepartmentTakesNewTodos(db: DatabaseType, department: string | null | undefined): void {
  if (department && isDepartmentArchived(db, department)) throw new DepartmentArchivedError(department);
}

/**
 * Archive or un-archive a department; true when that changed anything. Archiving a
 * department with no Todos yet registers it first, so its prefix is reserved from then on.
 */
export function setDepartmentArchived(db: DatabaseType, slug: string, archived: boolean, companyPrefix: string): boolean {
  return db.transaction((): boolean => {
    if (!archived) return db.prepare("DELETE FROM department_archives WHERE slug = ?").run(slug).changes > 0;
    resolveDepartmentPrefix(db, slug, companyPrefix);
    return db.prepare("INSERT OR IGNORE INTO department_archives (slug, archived_at) VALUES (?, ?)").run(slug, new Date().toISOString()).changes > 0;
  }).immediate();
}

/** What archiving would leave behind, for the confirmation the archive route asks for. */
export function openTodoCount(db: DatabaseType, department: string): number {
  return Number(
    db.prepare("SELECT COUNT(*) FROM work_items WHERE department = ? AND status NOT IN ('done','cancelled')").pluck().get(department),
  );
}
