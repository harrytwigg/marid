/** The assignee value that means "the operator" — a person, not an employee.
 *  The `@` keeps it out of the employee namespace: no employee name can start
 *  with one (org.ts refuses it). */
export const OPERATOR_ASSIGNEE = '@operator';

/** The `assignee` value that means "no assignee at all": a list/search filter
 *  (`assignee IS NULL`) and, on the assign route and tool, the request to clear
 *  the assignee. It is never stored, and like `@operator` the `@` keeps it out of
 *  the employee namespace. */
export const UNASSIGNED_FILTER = '@unassigned';
