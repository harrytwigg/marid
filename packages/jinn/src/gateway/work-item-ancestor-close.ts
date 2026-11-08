import { OWNER_ADDRESSED_PARENT_STATUSES } from "../work-items/review-addressee.js";
import { getWorkItem, type WorkItem, type WorkItemStatus } from "../work-items/store.js";
import { orgRegistry } from "./org-registry.js";
import { isSystemEmployeeName } from "./system-employees.js";
import type { StatusLane, StatusLaneResult } from "./work-item-status-lane.js";

/**
 * The ancestor-owner close: an employee that owns a Todo above another may move
 * that Todo from `in_review` to `done`, with a note, at any depth and whoever
 * produced it, its own work included. The self-review ban still holds one level
 * up: a root has no ancestor, so its review always reaches the operator, or the
 * owner of its own parent.
 */

/** The ancestor an employee owns above a Todo, and whether it is the parent. */
export type AncestorStanding = { ancestorId: string; direct: boolean };

/** What a `parent-owner` lane carries when the move is an ancestor-owner close. */
export type AncestorCloseFields = AncestorStanding & { ownWork: boolean };

/** What the status lane lends this module (it owns the audit-trail reading). */
export type AncestorCloseHooks = {
  /** Why `employee` had a hand in `item`, if it did. */
  ownWork(employee: string, item: WorkItem): string | undefined;
  /** A session other than `exceptSessionId` still working on `item`. */
  liveWork(item: WorkItem, exceptSessionId: string): StatusLaneResult | undefined;
};

/**
 * The nearest strict ancestor of `item` assigned to `employee` while it is
 * `executing` or `blocked`: the states in which an owner is told about work
 * under it. Read live, so a reassigned, parked or closed ancestor, or an
 * employee that left the org, has no standing at once. Walks up through
 * ancestors that are not the employee's, and through its own that are not in
 * those states; cycle-safe.
 */
export function ancestorOwnerStanding(employee: string, item: Pick<WorkItem, "id" | "parentId">): AncestorStanding | undefined {
  if (!orgRegistry().has(employee) || isSystemEmployeeName(employee)) return undefined;
  const seen = new Set<string>([item.id]);
  let parentId = item.parentId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const ancestor = getWorkItem(parentId);
    if (!ancestor) return undefined;
    if (ancestor.assignee === employee && OWNER_ADDRESSED_PARENT_STATUSES.has(ancestor.status)) {
      return { ancestorId: ancestor.id, direct: ancestor.id === item.parentId };
    }
    parentId = ancestor.parentId;
  }
  return undefined;
}

/**
 * The lane for `employee`'s session moving `item` to `done`, or `undefined`
 * when this is not that move (any other target or status, or no standing), which
 * leaves it to the other lanes. With standing the move is decided here: the
 * employee's own hand in the work does not hold it, a session still working on
 * the Todo does unless it is the caller's own, and the note is the reason the
 * gateway posts.
 */
export function resolveAncestorOwnerClose(
  who: { employee: string | undefined; sessionId: string },
  item: WorkItem,
  target: WorkItemStatus,
  note: string,
  hooks: AncestorCloseHooks,
): StatusLaneResult | undefined {
  if (target !== "done" || item.status !== "in_review" || !who.employee) return undefined;
  const standing = ancestorOwnerStanding(who.employee, item);
  if (!standing) return undefined;
  const live = hooks.liveWork(item, who.sessionId);
  if (live) return live;
  if (!note) return { ok: false, status: 400, error: `accepting Todo ${item.id} needs the reason in note: it is posted on the Todo as a comment` };
  const ownWork = hooks.ownWork(who.employee, item) !== undefined;
  return { ok: true, lane: { kind: "parent-owner", employee: who.employee, ancestor: { ...standing, ownWork } } };
}

/** The audit detail a `parent-owner` lane adds to its status event. */
export function parentOwnerEventDetail(lane: Extract<StatusLane, { kind: "parent-owner" }>): Record<string, unknown> {
  const { ancestor } = lane;
  return {
    parentOwner: true,
    ...(ancestor && !ancestor.direct ? { ancestorOwner: ancestor.ancestorId } : {}),
    ...(ancestor?.ownWork ? { ownWork: true } : {}),
  };
}

/** The comment the gateway posts when an ancestor's owner closes a Todo. */
export function ancestorCloseComment(lane: Extract<StatusLane, { kind: "parent-owner" }>, note: string): string {
  const { ancestor } = lane;
  const owns = ancestor && !ancestor.direct ? `ancestor Todo ${ancestor.ancestorId}` : "the parent Todo";
  return `Accepted as done by ${lane.employee}, who owns ${owns}. Reason: ${note}`;
}

/** The transition options a `parent-owner` lane carries: a send-back is the review
 *  bounce; an ancestor's close is the one `done` the store's session-executed ban
 *  gives way to (the owner may have run the work itself). */
export function parentOwnerMoveOptions(lane: StatusLane, target: WorkItemStatus): { bounce?: true; ancestorOwnerClose?: true } {
  if (lane.kind !== "parent-owner") return {};
  if (lane.ancestor) return { ancestorOwnerClose: true };
  return target === "executing" ? { bounce: true } : {};
}
