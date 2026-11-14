import { initDb } from "../shared/db.js";
import type { DepartmentScope } from "../work-items/department-scope.js";

const SHOWN = 10;

/**
 * FR-002: a Todo's scope is its root's department, so a sub-task whose own department
 * column differs from a non-open root's is in the root's scope all the same. This is
 * the report the scan makes of those, since the department registry is the module
 * that reads both the files and the work-items registry. It changes nothing.
 */
export function reportStraddlingSubtasks(warn: (message: string) => void, scopeOf: (slug: string) => DepartmentScope): void {
  let rows: Array<{ id: string; department: string | null; root_id: string; root_department: string }>;
  try {
    rows = initDb()
      .prepare(
        `SELECT c.id, c.department, c.root_id, r.department AS root_department
           FROM work_items c JOIN work_items r ON r.id = c.root_id
          WHERE c.id != c.root_id AND r.department IS NOT NULL AND c.department IS NOT r.department
          ORDER BY c.id`,
      )
      .all() as typeof rows;
  } catch {
    return;
  }
  const straddling = rows.filter((row) => scopeOf(row.root_department) !== "open");
  if (straddling.length === 0) return;
  const shown = straddling.slice(0, SHOWN).map((row) => `${row.id} (${row.department ?? "no department"}, root ${row.root_id} in ${row.root_department})`);
  const more = straddling.length > SHOWN ? ` and ${straddling.length - SHOWN} more` : "";
  warn(`${straddling.length} sub-task(s) sit in a different department from their non-open root and follow the root's scope: ${shown.join(", ")}${more}`);
}
