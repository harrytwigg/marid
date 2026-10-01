import crypto from "node:crypto";
import { resolveApprovalRouteTarget, resolveRootApprovalTarget } from "./approval-authority.js";
import { isOrgAncestor, resolveOrgHierarchy } from "./org-hierarchy.js";
import { orgRegistry } from "./org-registry.js";
import type { WorkItemCaller } from "./work-item-arming.js";
import { isPortalAgentSession, listSessionsByWorkItem } from "../sessions/registry.js";
import { remoteMcpHasOperatorStanding } from "./remote-mcp/rules.js";
import { TODO_DISPATCHER_NAME } from "./system-employees.js";
import type { Employee, Session } from "../shared/types.js";
import { getWorkItemClaim } from "../work-items/claims.js";
import { isExecutionAttempt } from "../work-items/link-role.js";
import type { WorkItem, WorkItemStatus } from "../work-items/store.js";

/**
 * Who may act on a Todo when the caller is not the operator.
 *
 * The route file asks these questions on the way into assign, archive,
 * dispatch, delegate, request-approval, and status, and each answer is a rule
 * rather than plumbing — so they read together here instead of a page apart
 * among the handlers. Approval DECISIONS are a separate authority and live in
 * `approval-authority.ts`.
 */

export function ownsWorkItem(session: Session, item: WorkItem, linked: Session[]): boolean {
  if (linked.some((s) => s.id === session.id)) return true;
  if (item.assignee && session.employee && item.assignee === session.employee) return true;
  return item.source === 'session' && !!item.sourceRef?.startsWith(`session:${session.id}:`);
}

/** The three ways an employee has standing over a Todo: the org root has it
 *  everywhere, the routed owner has it on its own, and a manager or executive
 *  has it over anyone below them in the tree. */
function hasStandingOverWorkItem(roster: Map<string, Employee>, employee: Employee, employeeName: string, item: WorkItem): boolean {
  const root = resolveRootApprovalTarget();
  if (root?.kind === 'employee' && root.name === employeeName) return true;
  const owner = resolveApprovalRouteTarget(item).owner;
  if (owner === employeeName) return true;
  if (!owner || (employee.rank !== 'manager' && employee.rank !== 'executive')) return false;
  return isOrgAncestor(resolveOrgHierarchy(roster), employeeName, owner);
}

export function authorizeWorkItemOwnerManagerOrRoot(
  caller: WorkItemCaller,
  item: WorkItem,
  action: string,
): { ok: true } | { ok: false; status: 403; error: string } {
  if (caller.kind === 'operator') return { ok: true };
  // The COO lane is the operator's own surface with a session id attached, and
  // the portal is deliberately not an org employee — so the identity check
  // below would refuse it for the very shape that makes it authoritative.
  if (isPortalAgentSession(caller.session)) return { ok: true };
  // the remote MCP connector is the operator's own door too; its
  // route list, not this check, bounds which of these actions it can reach.
  if (remoteMcpHasOperatorStanding(caller)) return { ok: true };
  const employeeName = caller.session.employee;
  if (!employeeName) {
    return { ok: false, status: 403, error: `session ${caller.callerId} has no employee identity and cannot ${action} Todo ${item.id}` };
  }
  const roster = orgRegistry();
  const employee = roster.get(employeeName);
  if (!employee) {
    return { ok: false, status: 403, error: `employee "${employeeName}" is not in the org roster and cannot ${action} Todo ${item.id}` };
  }
  if (hasStandingOverWorkItem(roster, employee, employeeName, item)) return { ok: true };
  return {
    ok: false,
    status: 403,
    error: `employee "${employeeName}" does not own Todo ${item.id} and is not its authorized manager/root; cannot ${action}`,
  };
}

/**
 * The session key the gateway gives a Dispatcher it starts on a Todo.
 *
 * Only `startTodoDispatcher` mints one, and no route lets a caller choose a
 * session key, so the key is what binds a Dispatcher session to the one Todo it
 * was started for — the binding `authorizeWorkItemDelegation` reads.
 */
export function todoDispatcherSessionKey(workItemId: string): string {
  return `${todoDispatcherSessionKeyPrefix(workItemId)}${crypto.randomUUID()}`;
}

function todoDispatcherSessionKeyPrefix(workItemId: string): string {
  return `todo-dispatcher:${workItemId}:`;
}

/**
 * A Dispatcher the gateway started on THIS Todo and that has not handed it on
 * yet: the built-in employee, linked to the Todo, under the key minted for it,
 * and still holding the Todo's claim. A session that is only called
 * `todo-dispatcher`, or a Dispatcher started on another Todo, is not one.
 *
 * The claim is what makes the standing one-shot. The hand-off releases it, and
 * the delegate's session is the Dispatcher's child, so every callback from that
 * delegate wakes the Dispatcher again. Without the claim clause, a Dispatcher
 * woken after its producer went idle could reassign the Todo and start a second
 * attempt beside the first.
 */
function isDispatcherRoutingTodo(session: Session, item: WorkItem): boolean {
  return session.employee === TODO_DISPATCHER_NAME
    && session.workItemId === item.id
    && !!session.sessionKey?.startsWith(todoDispatcherSessionKeyPrefix(item.id))
    && getWorkItemClaim(item.id)?.sessionId === session.id;
}

/**
 * Who may delegate an existing Todo from a session.
 *
 * The owner/manager/root rule, plus two callers it cannot see. The session that
 * created the Todo hands on what it made. And the Dispatcher acts for the
 * operator who pressed Dispatch: routing is the whole of its job, so on an
 * assigned Todo — whose owner is the assignee, not the Dispatcher — the
 * owner rule would refuse the one call it exists to make. That standing is
 * bound to the Todo the Dispatcher was started for, and lasts only until it
 * hands that Todo on: another Todo, a second hand-off, or any other action goes
 * through the ordinary rule.
 *
 * Whether the Todo is free to take is a separate question, answered by the
 * claim the delegation takes next, so none of these callers can start a second
 * attempt on top of a live one.
 */
export function authorizeWorkItemDelegation(
  caller: Extract<WorkItemCaller, { kind: 'session' }>,
  item: WorkItem,
): { ok: true } | { ok: false; status: 403; error: string } {
  const created = item.sourceRef?.startsWith(`session:${caller.callerId}:`)
    || item.sourceRef?.startsWith(`delegate:${caller.callerId}:`);
  if (created || isDispatcherRoutingTodo(caller.session, item)) return { ok: true };
  return authorizeWorkItemOwnerManagerOrRoot(caller, item, "delegate");
}

/** Every refusal here names the way forward, because the way forward always
 *  exists: the executor moves the Todo to `in_review` and asks for approval. */
function canReviewWorkItemDone(session: Session, item: WorkItem, linked: Session[]): { ok: true } | { ok: false; error: string } {
  const instead = `completion is the reviewer's — move Todo ${item.id} to in_review and request approval`;
  if (item.status !== 'in_review') {
    return { ok: false, error: `Todo ${item.id} is ${item.status}, and done is not an agent shortcut: ${instead}` };
  }
  if (linked.some((s) => s.id === session.id && isExecutionAttempt(s))) {
    return { ok: false, error: `session ${session.id} executed Todo ${item.id} and cannot close it (self-review ban): ${instead}, or close it from the human review surface` };
  }
  return { ok: true };
}

/**
 * Status is the one Todo write open to every authenticated session.
 *
 * Gating it on a relationship to the Todo bought nothing and cost honesty: a
 * participant that could do the work could not say where it had got to, and had
 * to ask someone with standing to perform the write for it. Status is low-stakes
 * and every participant needs it, so it is open — and each new caller arrives
 * without needing its own relation and its own 403.
 *
 * `done` stays bounded to `in_review` and is withheld from a linked execution
 * attempt because "never close your own work" is the basis of the review model.
 * Workflow phase sessions are linked for spend attribution, not because every
 * phase produced the Todo, so they are reviewers rather than execution attempts.
 * `cancelled` has no agent lane at all and the route refuses it before this
 * point, where cancellation's separate archive path is chosen.
 */
export function authorizeAgentWorkItemStatus(caller: WorkItemCaller, item: WorkItem, target: WorkItemStatus): { ok: true } | { ok: false; status: 403; error: string } {
  if (caller.kind === 'operator' || target !== 'done') return { ok: true };
  const review = canReviewWorkItemDone(caller.session, item, listSessionsByWorkItem(item.id));
  return review.ok ? { ok: true } : { ok: false, status: 403, error: review.error };
}
