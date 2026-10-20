import { orgRegistry } from "../gateway/org-registry.js";
import { getWorkItem, STICKY_STATUSES, type WorkItem } from "./store.js";

/** Who a Todo's `in_review` is addressed to: the operator's desk, or the
 *  employee that owns the Todo's parent and integrates it. */
export type ReviewAddressee = { kind: "operator" } | { kind: "employee"; employee: string };

const OPERATOR: ReviewAddressee = { kind: "operator" };

/**
 * The parent's owner when the Todo has a parent, that parent's assignee is an
 * employee in the live org, and the parent is not closed; otherwise the
 * operator. Computed on read and never stored, so a parent reassigned to the
 * operator, removed from the org or closed sends its children's reviews to the
 * operator from then on.
 */
export function reviewAddressee(item: Pick<WorkItem, "parentId">): ReviewAddressee {
  const parent = item.parentId ? getWorkItem(item.parentId) : undefined;
  if (!parent?.assignee || STICKY_STATUSES.has(parent.status)) return OPERATOR;
  return orgRegistry().has(parent.assignee) ? { kind: "employee", employee: parent.assignee } : OPERATOR;
}

/** The addressee's employee, when the review is addressed to one. */
export function reviewAddresseeEmployee(item: Pick<WorkItem, "parentId">): string | undefined {
  const addressee = reviewAddressee(item);
  return addressee.kind === "employee" ? addressee.employee : undefined;
}
