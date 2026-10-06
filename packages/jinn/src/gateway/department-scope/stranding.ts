import { initDb } from "../../shared/db.js";
import {
  departmentScope,
  employeeDepartment,
  LIVE_HOLD_LOOKUPS,
  mayHoldTodo,
  type DepartmentScope,
  type HoldLookups,
} from "../../work-items/department-scope.js";

/**
 * FR-015's stranding refusals for the two org-side changes: a department's scope, and
 * an employee's department. (A Todo's own department change is refused in the store,
 * `work-items/department-guard.ts`.) Each asks: under the change, which open Todos are
 * held by someone who could hold them before and could not after? A refusal names
 * them, so the operator knows whom to reassign first.
 *
 * Only violations the change itself would create count. A holding that is already
 * outside the rules, from a hand-edited YAML, is the scan's to report; it does not
 * block an unrelated change.
 */

export interface Holding {
  todo: string;
  assignee: string;
}

function openHoldings(): Array<Holding & { rootDepartment: string | null }> {
  const rows = initDb()
    .prepare(
      `SELECT w.id AS todo, w.assignee AS assignee, r.department AS root_department
         FROM work_items w JOIN work_items r ON r.id = w.root_id
        WHERE w.assignee IS NOT NULL AND w.status NOT IN ('done', 'cancelled')
        ORDER BY w.id`,
    )
    .all() as Array<{ todo: string; assignee: string; root_department: string | null }>;
  return rows.map((row) => ({ todo: row.todo, assignee: row.assignee, rootDepartment: row.root_department }));
}

function stranded(next: HoldLookups): Holding[] {
  return openHoldings()
    .filter((hold) => mayHoldTodo(hold.assignee, hold.rootDepartment, LIVE_HOLD_LOOKUPS) && !mayHoldTodo(hold.assignee, hold.rootDepartment, next))
    .map(({ todo, assignee }) => ({ todo, assignee }));
}

/** The holdings giving `slug` the scope `scope` would strand. */
export function strandedByScopeChange(slug: string, scope: DepartmentScope): Holding[] {
  return stranded({ scopeOf: (department) => (department === slug ? scope : departmentScope(department)), departmentOf: employeeDepartment });
}

/** The holdings moving `employee` into `department` would strand. */
export function strandedByEmployeeMove(employee: string, department: string): Holding[] {
  return stranded({ scopeOf: departmentScope, departmentOf: (name) => (name === employee ? department : employeeDepartment(name)) });
}

export function strandingMessage(change: string, holdings: readonly Holding[]): string {
  const named = holdings.map((hold) => `${hold.todo} (held by ${hold.assignee})`).join(", ");
  return `${change} would strand Todos whose holders could no longer hold them: ${named}. Reassign them first`;
}

let reported = "";

/**
 * FR-015: holdings outside the rules can only come from a hand edit (moving an employee's
 * YAML, or rewriting a `department.yaml`), which nothing refuses. The org scan reports
 * them, once per change, and nothing new starts on them (the Dispatcher, the board walk
 * and the link check each refuse).
 */
export function reportHoldingViolations(warn: (message: string) => void): void {
  let violations: Holding[];
  try {
    violations = openHoldings().filter((hold) => !mayHoldTodo(hold.assignee, hold.rootDepartment, LIVE_HOLD_LOOKUPS));
  } catch {
    return;
  }
  const signature = violations.map((hold) => `${hold.todo}:${hold.assignee}`).join(",");
  if (signature === reported) return;
  reported = signature;
  if (violations.length === 0) return;
  const shown = violations.slice(0, 10).map((hold) => `${hold.todo} (held by ${hold.assignee})`).join(", ");
  warn(`${violations.length} Todo(s) are held by an employee the department rules no longer allow, after a hand edit; reassign them: ${shown}${violations.length > 10 ? " and more" : ""}`);
}
