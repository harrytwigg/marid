/** The assignee value that means "the operator" — a person, not an employee.
 *  The `@` keeps it out of the employee namespace: no employee name can start
 *  with one (org.ts refuses it). */
export const OPERATOR_ASSIGNEE = '@operator';

/** The `assignee` list/search filter value that means "no assignee at all".
 *  A filter sentinel only — it is never stored, and like `@operator` the `@`
 *  keeps it out of the employee namespace. */
export const UNASSIGNED_FILTER = '@unassigned';
