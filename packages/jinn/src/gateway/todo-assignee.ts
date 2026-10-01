import type { Employee } from "../shared/types.js";
import { OPERATOR_ASSIGNEE } from "../work-items/assignment.js";

/**
 * Who may hold a Todo. One answer for every surface that sets an assignee: the
 * assign route, the operator pen's PATCH, delegation and Talk.
 *
 * A Todo's assignee is an employee on the roster, or the operator (stored as
 * `@operator`), but never a system employee: the Dispatcher and the Shaper
 * route and shape Todos and own none. Delegation runs the assignee, so it
 * takes an employee only.
 */

export type AssigneeCheck = { ok: true; employee: Employee | undefined } | { ok: false; error: string };

export function checkAssignee(
  roster: ReadonlyMap<string, Employee>,
  name: string,
  { operator }: { operator: boolean },
): AssigneeCheck {
  if (name === OPERATOR_ASSIGNEE) {
    return operator ? { ok: true, employee: undefined } : { ok: false, error: `${OPERATOR_ASSIGNEE} is the operator, a person; delegate to an employee instead` };
  }
  const employee = roster.get(name);
  if (!employee) {
    const near = nearestEmployee(name, [...roster.keys()]);
    const operatorHint = operator ? `, or assign ${OPERATOR_ASSIGNEE} for the operator` : "";
    return { ok: false, error: `unknown employee "${name}"${near ? `. Did you mean "${near}"?` : ""} Check find_employees or GET /api/org for valid employees${operatorHint}` };
  }
  if (employee.system) {
    return { ok: false, error: `"${name}" is a system employee and is never a Todo's assignee — choose an employee by role${operator ? `, or assign ${OPERATOR_ASSIGNEE} for the operator` : ""}` };
  }
  return { ok: true, employee };
}

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev.splice(0, prev.length, ...curr);
  }
  return prev[b.length];
}

function nearestEmployee(name: string, names: string[]): string | undefined {
  return names
    .map((n) => ({ n, d: levenshtein(name.toLowerCase(), n.toLowerCase()) }))
    .filter((x) => x.d <= 4 || x.n.toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes(x.n.toLowerCase()))
    .sort((a, b) => a.d - b.d || a.n.localeCompare(b.n))[0]?.n;
}
