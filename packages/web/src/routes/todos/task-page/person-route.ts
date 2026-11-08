import { OPERATOR_ASSIGNEE } from "../util"

/** The lane the operator's person choice is written through. */
export type PersonLane = "assign-operator" | "unassign" | "person"

/**
 * Where a person choice goes. A choice that leaves exactly what assign-to-the-operator, or unassign, leaves (`assignee` is
 * `@operator` with no person row, or null) goes through that same route, so it has the same endpoint, the same audit event and
 * the same downstream effects as it always had. Yourself with an agent held, a user in either direction, or the operator
 * replacing a user's row differ from the assignee, so only the person write can say them.
 */
export function personLane(item: { assignee?: string | null; humanAssignee?: string | null }, person: string | null): PersonLane {
  if (person === OPERATOR_ASSIGNEE && !item.assignee && !item.humanAssignee) return "assign-operator"
  if (person === null && item.assignee === OPERATOR_ASSIGNEE && item.humanAssignee === OPERATOR_ASSIGNEE) return "unassign"
  return "person"
}
