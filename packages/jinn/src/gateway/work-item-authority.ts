import crypto from "node:crypto";
import { isOrgAncestor, resolveOrgHierarchy } from "./org-hierarchy.js";
import { orgRegistry } from "./org-registry.js";
import type { WorkItemCaller } from "./work-item-arming.js";
import { resolveOrgRoot, resolveWorkItemOwner } from "./work-item-owner.js";
import { isPortalAgentSession, listSessionsByWorkItem } from "../sessions/registry.js";
import { remoteMcpHasOperatorStanding } from "./remote-mcp/rules.js";
import { TODO_DISPATCHER_NAME } from "./system-employees.js";
import type { Employee, Session } from "../shared/types.js";
import { getWorkItemClaim } from "../work-items/claims.js";
import type { WorkItem } from "../work-items/store.js";
import { isExecutionAttempt } from "../work-items/link-role.js";
import { neverReachedEngine } from "../sessions/engine-reach.js";

/**
 * Who may act on a Todo when the caller is not the operator.
 *
 * The route file asks these questions on the way into assign, archive,
 * dispatch, delegate, and status, and each answer is a rule rather than
 * plumbing — so they read together here instead of a page apart among the
 * handlers. Who owns a Todo and who the root is live in `work-item-owner.ts`.
 */

/** The three ways an employee has standing over a Todo: the org root has it
 *  everywhere, the routed owner has it on its own, and a manager or executive
 *  has it over anyone below them in the tree. */
function hasStandingOverWorkItem(roster: Map<string, Employee>, employee: Employee, employeeName: string, item: WorkItem): boolean {
  const root = resolveOrgRoot();
  if (root?.kind === 'employee' && root.name === employeeName) return true;
  const owner = resolveWorkItemOwner(item);
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
 * A hand-off that never started is not spent either: a caller whose own
 * delegate on this Todo was refused before its engine ever ran may hand the
 * Todo on again, once.
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
  if (handedOffStillborn(caller.callerId, item)) return { ok: true };
  return authorizeWorkItemOwnerManagerOrRoot(caller, item, "delegate");
}

/**
 * A hand-off the caller may make again: the Todo's latest execution attempt is
 * this caller's own delegate, every turn it ran was refused before its engine
 * started (an engine its department does not run, a missing binary, a spent
 * budget), so it did no work, and the Todo still sits with that delegate. Only
 * once per caller and Todo: a second refused delegate means the cause persists,
 * and retrying again would only loop.
 *
 * A delegate whose engine ran at all, even a turn that then threw, may have done
 * work; that, a live delegate, a Todo reassigned since, or a later attempt by
 * someone else is the ordinary case, and the ordinary rule decides.
 */
function handedOffStillborn(callerId: string, item: WorkItem): boolean {
  const attempts = listSessionsByWorkItem(item.id)
    .filter(isExecutionAttempt)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const latest = attempts[0];
  if (!latest || latest.parentSessionId !== callerId || latest.status !== 'error') return false;
  if (!neverReachedEngine(latest) || item.assignee !== latest.employee) return false;
  return attempts.filter((session) => session.parentSessionId === callerId && neverReachedEngine(session)).length === 1;
}
