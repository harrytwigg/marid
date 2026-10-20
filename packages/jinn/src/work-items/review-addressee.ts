import { orgRegistry } from "../gateway/org-registry.js";
import { getWorkItem, type WorkItem, type WorkItemStatus } from "./store.js";

/** Who a Todo's `in_review` is addressed to: the operator's desk, or the
 *  employee that owns the Todo's parent and integrates it. */
export type ReviewAddressee = { kind: "operator" } | { kind: "employee"; employee: string };

const OPERATOR: ReviewAddressee = { kind: "operator" };

/** The parent statuses in which its owner is woken or escalated to about a
 *  child, so a review addressed to them is never parked with someone who will
 *  not be told. A parent in `backlog` or `in_review`, or closed, is not one. */
const OWNER_ADDRESSED_PARENT_STATUSES: ReadonlySet<WorkItemStatus> = new Set<WorkItemStatus>(["executing", "blocked"]);

/**
 * The parent's owner when the Todo has a parent, that parent's assignee is an
 * employee in the live org, and the parent is `executing` or `blocked`;
 * otherwise the operator. Computed on read and never stored, so a parent
 * reassigned to the operator, removed from the org, closed or moved out of work
 * sends its children's reviews to the operator from then on.
 */
export function reviewAddressee(item: Pick<WorkItem, "parentId">): ReviewAddressee {
  return addresseeOfParent(item.parentId ? getWorkItem(item.parentId) : undefined);
}

/** The same rule from the parent row itself, for callers that already hold it (a tree walk). */
export function addresseeOfParent(parent: Pick<WorkItem, "assignee" | "status"> | undefined): ReviewAddressee {
  if (!parent?.assignee || !OWNER_ADDRESSED_PARENT_STATUSES.has(parent.status)) return OPERATOR;
  return orgRegistry().has(parent.assignee) ? { kind: "employee", employee: parent.assignee } : OPERATOR;
}

/** The addressee's employee, when the review is addressed to one. */
export function reviewAddresseeEmployee(item: Pick<WorkItem, "parentId">): string | undefined {
  const addressee = reviewAddressee(item);
  return addressee.kind === "employee" ? addressee.employee : undefined;
}
