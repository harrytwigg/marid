import crypto from "node:crypto";
import { BOARD_WALK_STARTED_BY } from "../board-walk/started-sessions.js";
import { isOrgAncestor, resolveOrgHierarchy } from "./org-hierarchy.js";
import { orgRegistry } from "./org-registry.js";
import type { WorkItemCaller } from "./work-item-arming.js";
import { resolveOrgRoot, resolveWorkItemOwner, sourceSessionId } from "./work-item-owner.js";
import { getSession, isPortalAgentSession, listSessionsByWorkItem } from "../sessions/registry.js";
import { remoteMcpHasOperatorStanding } from "./remote-mcp/rules.js";
import { TODO_DISPATCHER_NAME, isSystemEmployeeName } from "./system-employees.js";
import type { Employee, Session } from "../shared/types.js";
import { STICKY_STATUSES, getWorkItem, getWorkItemTree, type WorkItem } from "../work-items/store.js";
import { isExecutionAttempt } from "../work-items/link-role.js";
import { recordedDelegateSessionId } from "../work-items/employee-session-delegation.js";
import { neverReachedEngine } from "../sessions/engine-reach.js";
import { OPERATOR_ASSIGNEE } from "../work-items/operator-assignee.js";

/**
 * Who may act on a Todo when the caller is not the operator.
 *
 * The route file asks these questions on the way into assign, archive,
 * dispatch, delegate, and status, and each answer is a rule rather than
 * plumbing — so they read together here instead of a page apart among the
 * handlers. Who owns a Todo and who the root is live in `work-item-owner.ts`.
 */

/** The four ways an employee has standing over a Todo: the org root has it
 *  everywhere, the routed owner has it on its own, the owner of any Todo above
 *  it in its tree has it over everything below, and a manager or executive has
 *  it over anyone below them in the tree.
 *
 *  The ancestor clause is needed because assigning a sub-task moves its owner
 *  to the assignee: whoever hands a sub-task on, at any depth, would otherwise
 *  lose the standing to dispatch, delegate or reassign it, unless their rank
 *  and place in the org tree happened to cover the assignee. */
function hasStandingOverWorkItem(roster: Map<string, Employee>, employee: Employee, employeeName: string, item: WorkItem): boolean {
  const root = resolveOrgRoot();
  if (root?.kind === 'employee' && root.name === employeeName) return true;
  const owner = resolveWorkItemOwner(item);
  if (owner === employeeName) return true;
  if (ownsAncestorOf(roster, item, employeeName)) return true;
  if (!owner || (employee.rank !== 'manager' && employee.rank !== 'executive')) return false;
  return isOrgAncestor(resolveOrgHierarchy(roster), employeeName, owner);
}

/** Whether `employeeName` owns a Todo above `item`. An ancestor's owner is its
 *  assignee, or, while it is unassigned, the employee whose session created it.
 *  Unlike `resolveWorkItemOwner` this never falls back to whoever has a session
 *  linked to it, which would hand a reviewer or consultant the whole tree, and
 *  an ancestor assigned to the operator has no employee owner at all. */
function ownsAncestorOf(roster: Map<string, Employee>, item: WorkItem, employeeName: string): boolean {
  const seen = new Set<string>([item.id]);
  let parentId = item.parentId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const ancestor = getWorkItem(parentId);
    if (!ancestor) return false;
    if (ancestorOwner(roster, ancestor) === employeeName) return true;
    parentId = ancestor.parentId;
  }
  return false;
}

function ancestorOwner(roster: Map<string, Employee>, ancestor: WorkItem): string | null {
  if (ancestor.assignee) return roster.has(ancestor.assignee) ? ancestor.assignee : null;
  const creatorId = sourceSessionId(ancestor);
  const creator = creatorId ? getSession(creatorId)?.employee : null;
  return creator && roster.has(creator) && !isSystemEmployeeName(creator) ? creator : null;
}

/**
 * Whether the caller may give `item` to a new employee owner, judged on what
 * sits below it. Owning a Todo carries standing over every Todo under it
 * (`ownsAncestorOf`), so an assignment or a delegation hands the new owner
 * that standing too. A caller may pass on only the standing it already holds:
 * it needs standing over each open sub-task as well. Without this, claiming an
 * unassigned parent for yourself, or being a session linked to one, would win
 * a whole subtree of other people's work. A Todo with nothing open below it
 * passes.
 */
export function authorizeAssignOverSubTasks(
  caller: WorkItemCaller,
  item: WorkItem,
  action: "assign" | "delegate" | "dispatch" = "assign",
): { ok: true } | { ok: false; status: 403; error: string } {
  const tree = getWorkItemTree(item.id);
  if (!tree) return { ok: true };
  const below: WorkItem[] = [];
  const walk = (node: typeof tree.root): void => {
    for (const child of node.children) {
      if (!STICKY_STATUSES.has(child.status)) below.push(child);
      walk(child);
    }
  };
  walk(tree.root);
  for (const sub of below) {
    if (authorizeWorkItemOwnerManagerOrRoot(caller, sub, "assign").ok) continue;
    return {
      ok: false,
      status: 403,
      error: `cannot ${action} Todo ${item.id}: its owner takes standing over the open sub-tasks below it, `
        + `and this caller has no standing over sub-task ${sub.id}, so the Todo's owner, their manager or the operator has to ${action} it`,
    };
  }
  return { ok: true };
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
    return {
      ok: false,
      status: 403,
      error: `session ${caller.callerId} has no employee identity and cannot ${action} Todo ${item.id}: `
        + `a session spawned without an employee has no standing over Todos, so the Todo's owner, their manager or the operator has to ${action} it`,
    };
  }
  const roster = orgRegistry();
  const employee = roster.get(employeeName);
  if (!employee) {
    return { ok: false, status: 403, error: `employee "${employeeName}" is not in the org roster and cannot ${action} Todo ${item.id}` };
  }
  if (hasStandingOverWorkItem(roster, employee, employeeName, item)) return { ok: true };
  if (isDispatcherStartedFor(caller.session, item)) return dispatcherRefusal(caller.callerId, caller.session, item, action);
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
 * with no delegate of its own on the Todo. A session that is only called
 * `todo-dispatcher`, or a Dispatcher started on another Todo, is not one.
 *
 * The hand-off is per-Todo, not per-claim: it is spent only when a delegation
 * from this Dispatcher actually exists. The claim is a lease, and a lease
 * running out is not a hand-off — a Dispatcher that blocked its Todo without
 * delegating and waited out the lease for the operator's answer still holds
 * the hand-off, or its answer could never be acted on. The claim keeps its
 * own job: the delegation takes it next, under its compare-and-swap, so
 * standing alone never starts a second attempt beside live work. And once a
 * delegate exists, the Dispatcher is spent for good: the delegate's session
 * is its child, so every callback from that delegate wakes it again, and a
 * Dispatcher woken after its producer went idle could otherwise reassign
 * the Todo and start a second attempt beside the first.
 *
 * A Dispatcher is also spent once a newer one has been started on the Todo
 * (a re-Dispatch): the newest Dispatcher is the one routing, and an older one
 * woken by a late answer must not hand the Todo on beside it. The claim used
 * to rule that out, and the claim no longer decides standing.
 */
function isDispatcherRoutingTodo(session: Session, item: WorkItem): boolean {
  return isDispatcherStartedFor(session, item)
    && !dispatcherHasHandedOff(session.id, item)
    && !newerDispatcher(session, item);
}

/** A Dispatcher started on this Todo after `session`, if any. */
function newerDispatcher(session: Session, item: WorkItem): Session | undefined {
  return listSessionsByWorkItem(item.id).find((other) => other.id !== session.id
    && isDispatcherStartedFor(other, item)
    && (other.createdAt.localeCompare(session.createdAt) || other.id.localeCompare(session.id)) > 0);
}

/** Whether this Dispatcher has already handed the Todo on: one of its own
 *  delegates is linked to the Todo as an execution attempt, or its brief
 *  landed in a session somebody else started (which spawns no child). */
function dispatcherHasHandedOff(callerId: string, item: WorkItem): boolean {
  return listSessionsByWorkItem(item.id)
    .some((attempt) => isExecutionAttempt(attempt) && attempt.parentSessionId === callerId)
    || recordedDelegateSessionId(item.id, callerId) !== undefined;
}

/** A Dispatcher the gateway started on THIS Todo, whether or not it has handed it on since. */
function isDispatcherStartedFor(session: Session, item: WorkItem): boolean {
  return session.employee === TODO_DISPATCHER_NAME
    && session.workItemId === item.id
    && !!session.sessionKey?.startsWith(todoDispatcherSessionKeyPrefix(item.id));
}

/**
 * The refusal for a Dispatcher on its own Todo, with the way on.
 *
 * A Dispatcher that still holds the hand-off is refused only the action it
 * asked for: delegate_task is still open to it, and a refusal that read as
 * spent would send it to block a Todo it could route.
 *
 * Once the hand-off is spent, its delegate is its child, so a delegate that
 * stopped before finishing reports to it, and the Dispatcher is woken holding
 * a Todo it may no longer route. Starting afresh on top of whatever that
 * delegate did is the operator's call. Resuming the delegate's own session is
 * not: that keeps the work, and the delegate is the Dispatcher's child to
 * message. A bare "not its owner" sent Dispatchers hunting for another session
 * to do it for them, which has no standing either. The delegate is named only
 * while the Todo still sits with it: after a reassignment, resuming it would
 * restart work the operator moved elsewhere.
 */
function dispatcherRefusal(callerId: string, session: Session, item: WorkItem, action: string): { ok: false; status: 403; error: string } {
  if (isDispatcherRoutingTodo(session, item) || handedOffStillborn(callerId, item)) {
    return {
      ok: false,
      status: 403,
      error: `this Dispatcher cannot ${action} Todo ${item.id}, but it still holds the Todo's hand-off: `
        + `hand it on with delegate_task { workItemId: "${item.id}" }`,
    };
  }
  const newer = newerDispatcher(session, item);
  if (newer && !dispatcherHasHandedOff(callerId, item)) {
    return {
      ok: false,
      status: 403,
      error: `this Dispatcher has been superseded: a newer Dispatcher (session ${newer.id}) was started on Todo ${item.id}, `
        + `so it routes the Todo and this one cannot ${action} it. Leave the routing to that Dispatcher.`,
    };
  }
  const delegate = listSessionsByWorkItem(item.id)
    .filter((attempt) => isExecutionAttempt(attempt) && attempt.parentSessionId === callerId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
  const resume = delegate && delegate.employee === item.assignee
    ? ` Its delegate is session ${delegate.id} (${delegate.employee}, ${delegate.status}): `
      + `to carry on after it stopped, resume it with send_to_session { sessionId: "${delegate.id}" }, which keeps the work it did.`
    : "";
  return {
    ok: false,
    status: 403,
    error: `this Dispatcher's hand-off is spent: it already handed Todo ${item.id} on, and cannot ${action} it again.${resume} `
      + `A fresh start is the operator's call: they press Dispatch on Todo ${item.id}.`,
  };
}

/**
 * The assignee binding on a hand-pressed Dispatch (MAR-163).
 *
 * The operator assigning an employee and pressing Dispatch is a routing
 * choice: the Dispatcher it starts hands the Todo to exactly that assignee,
 * never to someone else it prefers. The gateway refuses the override outright,
 * so a re-route cannot slip through when the prompt text is misread. A refused
 * bound hand-off is the dead end the persona already sends to blocked, with
 * the refusal and options — never a second choice.
 *
 * Two starts are not bound. An unset assignee, or @operator (a person nobody
 * can delegate to), leaves nobody to be bound to, so the Dispatcher chooses.
 * And a Dispatcher the board walk started carries the walk's own routing brief
 * (a reason and an engine preference) in its prompt; its routing stays its own
 * decision, marked by the transportMeta the walk stamps on its session.
 *
 * The binding is the assignee as Dispatch was pressed, which the start stamps
 * on the Dispatcher's session (`DISPATCH_ASSIGNEE_META_KEY`), not the assignee
 * as it delegates. Read late, someone with standing over the Todo could give
 * it to @operator mid-route and leave the Dispatcher free to hand it, and
 * standing over its open sub-tasks, to anyone. So once a Todo pressed with an
 * employee assignee has changed hands, the Dispatcher routes nobody: the press
 * it acts on no longer describes the Todo, handing it back would undo the
 * reassignment, and a fresh Dispatch on the new assignment is the operator's
 * call. One pressed with nobody to bind it to, whose Todo has since gone to an
 * employee, may hand it to that employee only. A Dispatcher started
 * before the stamp existed carries none, and is bound to the Todo as it stands.
 *
 * An unnamed engine-only delegation names nobody, but it still starts
 * execution outside the assignee, so a bound Dispatcher is refused that too:
 * the binding names the one employee who may take the Todo.
 */
function dispatcherAssigneeBinding(
  session: Session,
  item: WorkItem,
  delegate: string | undefined,
): { ok: false; status: 403; error: string } | undefined {
  if (!isDispatcherRoutingTodo(session, item)) return undefined;
  if (session.transportMeta?.startedBy === BOARD_WALK_STARTED_BY) return undefined;
  const pressed = assigneeAtPress(session, item);
  const current = item.assignee ?? "";
  if (pressed !== current) return changedHandsRefusal(item, pressed, current, delegate);
  if (delegate === current || !isEmployeeAssignee(current)) return undefined;
  const target = delegate === undefined ? "an unnamed engine" : `"${delegate}"`;
  return {
    ok: false,
    status: 403,
    error: `this Dispatcher was started by the operator's Dispatch on Todo ${item.id}, whose assignee is employee "${current}": `
      + `that assignment is binding, so it cannot hand the Todo to ${target} — `
      + `hand it to its assignee with delegate_task { task, employee: "${current}", workItemId: "${item.id}" }. `
      + `If that delegation is refused, block the Todo for the operator with the refusal and options rather than choosing someone else.`,
  };
}

/** The binding once the Todo's assignee is no longer the one pressed: a bound
 *  Dispatcher hands it to nobody, an unbound one only to an employee it has
 *  since gone to. */
function changedHandsRefusal(
  item: WorkItem,
  pressed: string,
  current: string,
  delegate: string | undefined,
): { ok: false; status: 403; error: string } | undefined {
  if (!isEmployeeAssignee(pressed)) {
    // Pressed unbound, it could choose anyone; since given to an employee, it
    // may still start that employee, and its own failed hand-off may retry.
    if (!isEmployeeAssignee(current) || delegate === current) return undefined;
    return {
      ok: false,
      status: 403,
      error: `this Dispatcher was started on Todo ${item.id} when its assignee was ${describeAssignee(pressed)}, `
        + `and it has since been assigned to ${describeAssignee(current)}, so it may hand the Todo only to them: `
        + `delegate_task { task, employee: "${current}", workItemId: "${item.id}" }. `
        + `If that delegation is refused, block the Todo for the operator with the refusal and options rather than choosing someone else.`,
    };
  }
  return {
    ok: false,
    status: 403,
    error: `this Dispatcher was started on Todo ${item.id} when its assignee was ${describeAssignee(pressed)}, `
      + `and it has since been reassigned to ${describeAssignee(current)}: the Dispatch it acts on no longer describes the Todo, `
      + `so it cannot hand the Todo on to anyone. Block the Todo for the operator with this refusal; `
      + `a fresh start on the new assignment is their call (they press Dispatch on Todo ${item.id}).`,
  };
}

/** Where a Dispatcher's session records the Todo's assignee as Dispatch was
 *  pressed: an employee, @operator, or empty for none. */
export const DISPATCH_ASSIGNEE_META_KEY = "dispatchAssignee";

/** The stamp a Dispatcher start puts on its session, read by the binding above. */
export function dispatchAssigneeMeta(item: WorkItem): Record<string, string> {
  return { [DISPATCH_ASSIGNEE_META_KEY]: item.assignee ?? "" };
}

/** The Todo's assignee when this Dispatcher was pressed, empty for none; the
 *  current one for a Dispatcher started before the stamp existed. */
function assigneeAtPress(session: Session, item: WorkItem): string {
  const stamped = session.transportMeta?.[DISPATCH_ASSIGNEE_META_KEY];
  return typeof stamped === "string" ? stamped : item.assignee ?? "";
}

function isEmployeeAssignee(assignee: string): boolean {
  return !!assignee && assignee !== OPERATOR_ASSIGNEE;
}

function describeAssignee(assignee: string): string {
  if (!assignee) return "nobody";
  return assignee === OPERATOR_ASSIGNEE ? OPERATOR_ASSIGNEE : `employee "${assignee}"`;
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
 * through the ordinary rule. On a hand-pressed Dispatch the standing carries
 * the assignee binding above: the Dispatcher hands the Todo to its assignee
 * and to nobody else.
 *
 * A claim that expired is not a hand-off either: a Dispatcher that never
 * delegated keeps this standing however long it waited, and the delegation
 * it then makes takes a fresh claim. That is the non-operator path that
 * re-arms an expired claim — no fresh Dispatch press is needed. A Dispatcher
 * that a newer one has superseded is excluded: it does not keep standing.
 *
 * A hand-off that never started is not spent either: a caller whose own
 * delegate on this Todo was refused before its engine ever ran may hand the
 * Todo on again, once.
 *
 * Whether the Todo is free to take is a separate question, answered by the
 * claim the delegation takes next, so none of these callers can start a second
 * attempt on top of a live one.
 *
 * Handing the Todo to a new employee also hands them standing over its open
 * sub-tasks, so, as for an assignment, the caller needs standing over each of
 * them, whichever of these routes let it delegate. The creating session is no
 * exception: the Todo may have been given to someone else since it made it.
 * A Dispatcher started on this Todo acts for whoever started it, so it is
 * judged by their standing, not its own (`dispatcherHandOn`).
 */
export function authorizeWorkItemDelegation(
  caller: Extract<WorkItemCaller, { kind: 'session' }>,
  item: WorkItem,
  /** The employee the delegation would hand the Todo to, when one is named. */
  delegateEmployee?: string,
): { ok: true } | { ok: false; status: 403; error: string } {
  const binding = dispatcherAssigneeBinding(caller.session, item, delegateEmployee);
  if (binding) return binding;
  const standing = delegationStanding(caller, item);
  if (!standing.ok) return standing;
  const newOwner = delegateEmployee !== undefined && delegateEmployee !== item.assignee;
  if (!newOwner) return standing;
  if (isDispatcherStartedFor(caller.session, item)) return dispatcherHandOn(caller.session, item);
  return authorizeAssignOverSubTasks(caller, item, "delegate");
}

/** Where a Dispatcher's session records the session that pressed Dispatch. */
export const DISPATCH_PRESSED_BY_META_KEY = "dispatchPressedBy";

/**
 * Whether a Dispatcher may hand its Todo to a new owner, judged by what sits
 * below it. A Dispatcher the operator, the board walk or a sweep started acts
 * for the operator and needs nothing more. One a session pressed acts for that
 * session, so it needs that session's standing over each open sub-task, judged
 * now rather than at the press: sub-tasks can be added or handed out in between.
 */
function dispatcherHandOn(session: Session, item: WorkItem): { ok: true } | { ok: false; status: 403; error: string } {
  const pressedBy = session.transportMeta?.[DISPATCH_PRESSED_BY_META_KEY];
  if (typeof pressedBy !== "string") return { ok: true };
  const presser = getSession(pressedBy);
  const handOn = presser
    ? authorizeAssignOverSubTasks({ kind: "session", callerId: presser.id, session: presser }, item, "delegate")
    : { ok: false as const, status: 403 as const, error: `the session that pressed Dispatch no longer exists` };
  if (handOn.ok) return handOn;
  return {
    ok: false,
    status: 403,
    error: `this Dispatcher was started by session ${pressedBy}'s Dispatch and hands Todo ${item.id} on with that session's standing: ${handOn.error}. `
      + `Hand it to its current assignee, or block it for the operator with this refusal`,
  };
}

/** Standing to delegate the Todo itself, before what sits below it is weighed. */
function delegationStanding(
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
