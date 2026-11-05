import { getSession, isCoordinatorSession, isOperatorCoordinatorTurn, isOperatorEmployeeTurn, listSessionsByWorkItem } from "../sessions/registry.js";
import { listWorkItemEvents } from "../work-items/event-log.js";
import { isExecutionAttempt } from "../work-items/link-role.js";
import { toWorkItemLinkRole } from "../work-items/link-role.js";
import { STICKY_STATUSES, type WorkItem, type WorkItemEvent, type WorkItemStatus } from "../work-items/store.js";
import { reviewAddresseeEmployee } from "../work-items/review-addressee.js";
import { isAgentLaneMove } from "../work-items/transition-edges.js";
import { orgRegistry } from "./org-registry.js";
import { remoteMcpHasOperatorStanding } from "./remote-mcp/rules.js";
import { workItemActor, type WorkItemCaller } from "./work-item-arming.js";

/**
 * Who may move a Todo where, decided at the route every status tool calls —
 * never by prompt.
 *
 * - The **operator lane** is the operator's own surface and the operator's
 *   remote connector. It walks every declared edge with human authority:
 *   closing, cancelling, reopening.
 * - The **agent lane** is every other session, review delegates included. It
 *   works inside the open statuses (`isAgentLaneMove`) and never closes,
 *   cancels or reopens; a move into `in_review` carries a summary.
 * - The **coordinator lane** is the one exception: the operator's coordinator
 *   chat may close a Todo as `done` on the operator's behalf, with a reason
 *   the gateway posts on the Todo, on a turn the operator's own message started
 *   ({@link isOperatorCoordinatorTurn}): a send from another session, a delegation
 *   brief or a sub-task's report landing in the chat is not the operator talking, so
 *   after a callback the coordinator asks the operator to close. Nothing else
 *   rides on it. The same holds, from
 *   `in_review` only, for an employee holding `closeTodos` in a web chat the
 *   operator opened with it, on a turn the operator's own message started: the
 *   grant is what opts that employee in, and a mention, delegation, cron run,
 *   child session, or a brief or send that lands in the chat never counts as the
 *   operator talking. The close is the operator's, and the event names the
 *   employee that carried it out.
 * - The **closer lane** is the operator's standing grant: an employee whose YAML
 *   says `closeTodos: true` may move a Todo to `done` as itself, with a reason
 *   the gateway posts on the Todo, from `in_review` only. `done` and nothing else: cancelling,
 *   reopening and cascading stay the operator's, and every other move by that
 *   employee is an ordinary agent move. The employee never closes work it had
 *   a hand in ({@link closerHandIn}), whichever of its sessions asks.
 */

export const WORK_ITEM_STATUSES: readonly WorkItemStatus[] = ["backlog", "executing", "in_review", "done", "blocked", "cancelled"];

export type StatusLane =
  | { kind: "operator" }
  | { kind: "coordinator"; actingAs: string; employee?: string }
  | { kind: "closer"; employee: string }
  | { kind: "parent-owner"; employee: string }
  | { kind: "agent" };

export type StatusLaneResult = { ok: true; lane: StatusLane } | { ok: false; status: number; error: string };

/** The operator's own surface, or the operator's remote connector (which acts
 *  with the operator's standing on every route it can reach). */
export function hasOperatorLane(caller: WorkItemCaller): boolean {
  return caller.kind === "operator" || remoteMcpHasOperatorStanding(caller);
}

function refuse(status: number, error: string): StatusLaneResult {
  return { ok: false, status, error };
}

const AGENT_LANE_SHAPE =
  "agents pick work up and put it down (backlog ↔ executing), hand it to review and take it back (executing ↔ in_review), "
  + "and stop or resume it (↔ blocked)";

/** `asOperator` from a session: the coordinator while the operator is talking to
 *  it ({@link isOperatorCoordinatorTurn}), or an employee holding `closeTodos`
 *  while the operator is talking to it ({@link isOperatorEmployeeTurn}), closing
 *  a Todo as `done` for the operator, with the reason it will post. Nothing else
 *  rides on it. */
function resolveCoordinatorLane(
  caller: Extract<WorkItemCaller, { kind: "session" }>,
  item: WorkItem,
  target: WorkItemStatus,
  note: string,
): StatusLaneResult {
  const coordinator = isOperatorCoordinatorTurn(caller.session);
  const closer = closerOf(caller);
  if (!coordinator && !(closer && isOperatorEmployeeTurn(caller.session))) return notTheOperatorTalking(caller, item, closer);
  if (target !== "done") {
    return refuse(403, "asOperator closes a Todo as done for the operator and nothing else: cancelling, archiving and reopening stay with the operator");
  }
  if (STICKY_STATUSES.has(item.status)) return refuse(403, `Todo ${item.id} is already ${item.status}; reopening closed work is the operator's`);
  // The grant exists to close reviewed work, so an employee's chat holds to in_review as the closer lane does.
  if (!coordinator && item.status !== "in_review") {
    return refuse(403, `an employee with closeTodos closes Todos that are in review: Todo ${item.id} is ${item.status}; move it to in_review first`);
  }
  if (!note) {
    return refuse(400, "asOperator needs the reason in note: closing a Todo for the operator is for exceptional cases, and the reason is posted on the Todo");
  }
  return { ok: true, lane: { kind: "coordinator", actingAs: workItemActor(caller), ...(coordinator ? {} : { employee: closer }) } };
}

/** Why `asOperator` is refused a session the operator is not talking through.
 *  A closeTodos employee is told it can still close reviewed work as itself. */
function notTheOperatorTalking(
  caller: Extract<WorkItemCaller, { kind: "session" }>,
  item: WorkItem,
  closer: string | undefined,
): StatusLaneResult {
  if (closer) {
    return refuse(403, `asOperator is for a web chat the operator opened with employee "${closer}", on a turn the operator's own message started; `
      + `without asOperator, closeTodos closes a Todo that is in review as "${closer}", unless "${closer}" had a hand in it`);
  }
  if (isCoordinatorSession(caller.session)) {
    return refuse(403, `asOperator is reserved for the operator's coordinator session, on a turn the operator's own message started: this turn was started by something else `
      + `(a message from another session, a delegation brief or a sub-task's report), so ask the operator to close Todo ${item.id}; it can stay in review until they do`);
  }
  const who = caller.session.employee ? `employee "${caller.session.employee}"` : `session ${caller.callerId}`;
  return refuse(403, `asOperator is reserved for the operator's coordinator session, on a turn the operator's own message started, and for a closeTodos employee in a chat the operator opened with it; ${who} moves Todo ${item.id} as itself`);
}

/** The employee a session acts as when the operator has granted it `closeTodos`.
 *  Read from the live roster at call time, so a revoked grant stops the next
 *  call and a session spawned before the grant is covered by it. */
function closerOf(caller: Extract<WorkItemCaller, { kind: "session" }>): string | undefined {
  const name = caller.session.employee;
  return name && orgRegistry().get(name)?.closeTodos === true ? name : undefined;
}

function sessionEmployee(sessionId: unknown): string | undefined {
  return typeof sessionId === "string" && sessionId ? getSession(sessionId)?.employee ?? undefined : undefined;
}

/** The employee behind a recorded move: stamped on the event by the status
 *  route, or else the employee of the session the actor names. */
function moveEmployee(event: WorkItemEvent): string | undefined {
  if (typeof event.detail?.actorEmployee === "string") return event.detail.actorEmployee;
  return event.actor?.startsWith("session:") ? sessionEmployee(event.actor.slice("session:".length)) : undefined;
}

/**
 * Why `employee` may not close `item`: it had a hand in the work. Judged from
 * the Todo's audit trail rather than the asking session's current link, so a
 * second session of the same employee, or a session since relinked to other
 * work, is held the same as the one that did it. A hand in the work is any of:
 * a session of the employee linked to execute it; the employee starting or
 * resuming it (any move into `executing` except a review bounce); or the
 * employee making the latest handoff into `in_review`. A session linked to
 * review it, or bouncing it back, is reviewing and leaves the close open.
 */
function closerHandIn(employee: string, item: WorkItem, { producedElsewhere = false } = {}): string | undefined {
  const events = listWorkItemEvents(item.id);
  if (events.some((event) => workedBy(event, employee))) return `a session of ${employee} was linked to work on it`;
  if (events.some((event) => startedBy(event, employee))) return `${employee} moved it to executing`;
  // A handoff is a hand in only when the mover produced the work. The parent's
  // owner relaying a delegated child's report into review did not produce it.
  if (producedElsewhere) return undefined;
  const handoff = events.filter((event) => event.toStatus === "in_review" && event.fromStatus !== "in_review").at(-1);
  return handoff && moveEmployee(handoff) === employee ? `${employee} handed it to review` : undefined;
}

/** A link to execute the Todo by a session of `employee`: the employee stamped
 *  on the event, or for an event older than the stamp, the session's own row. */
function workedBy(event: WorkItemEvent, employee: string): boolean {
  if (event.kind !== "session_linked" || toWorkItemLinkRole(event.detail?.role) !== "execute") return false;
  const linked = typeof event.detail?.employee === "string" ? event.detail.employee : sessionEmployee(event.detail?.sessionId);
  return linked === employee;
}

function startedBy(event: WorkItemEvent, employee: string): boolean {
  return event.kind === "status_change" && event.toStatus === "executing" && event.fromStatus !== "in_review"
    && moveEmployee(event) === employee;
}

/** A granted employee closing a Todo as `done`, with the reason it will post.
 *  Only reviewed work: the grant exists to close what is in review, and a close
 *  from any other open status would let an agent skip review. Closed work stays
 *  closed and `cascade` never reaches here (the fields parser refuses it off the
 *  operator surface), so this is the one close and nothing more. */
function resolveCloserLane(employee: string, item: WorkItem, note: string): StatusLaneResult {
  if (STICKY_STATUSES.has(item.status)) return refuse(403, `Todo ${item.id} is already ${item.status}; reopening closed work is the operator's`);
  if (item.status !== "in_review") {
    return refuse(403, `an employee with closeTodos closes Todos that are in review: Todo ${item.id} is ${item.status}; move it to in_review first`);
  }
  if (!note) {
    return refuse(400, `closing Todo ${item.id} needs the reason in note: it is posted on the Todo as a comment`);
  }
  const handIn = closerHandIn(employee, item);
  if (handIn) {
    return refuse(403, `${employee} cannot close Todo ${item.id}: ${handIn}, and an employee never closes its own work (self-review ban); another reviewer or the operator closes it`);
  }
  return { ok: true, lane: { kind: "closer", employee } };
}

/** The employee a session acts as when it owns the parent of a child Todo and
 *  the move is the accept (from `executing` or `in_review`: a delegated child's
 *  report lands with the owner whether or not the producer moved it to review)
 *  or the send-back (from `in_review`). Read live from the parent and the
 *  roster, so a reassigned parent hands the review elsewhere at once.
 *  `undefined` leaves the move to the other lanes. */
function parentOwnerOf(
  caller: Extract<WorkItemCaller, { kind: "session" }>,
  item: WorkItem,
  target: WorkItemStatus,
): string | undefined {
  const accepts = target === "done" && (item.status === "executing" || item.status === "in_review");
  const sendsBack = target === "executing" && item.status === "in_review";
  if (!accepts && !sendsBack) return undefined;
  const employee = caller.session.employee;
  return employee && reviewAddresseeEmployee(item) === employee ? employee : undefined;
}

const LIVE_SESSION_STATUSES: ReadonlySet<string> = new Set(["running", "waiting"]);

/** The owner accepting a child that is still `executing`: only one an employee is
 *  producing, and only once that employee's session has stopped. Anything else
 *  is left to the ordinary agent lane, which refuses the close. */
function resolveExecutingAccept(employee: string, item: WorkItem, note: string): StatusLaneResult | undefined {
  const producer = item.assignee;
  if (!producer || producer === employee || !orgRegistry().has(producer)) return undefined;
  if (listSessionsByWorkItem(item.id).some((session) => isExecutionAttempt(session) && LIVE_SESSION_STATUSES.has(session.status))) {
    return refuse(403, `Todo ${item.id} is still being worked on: a session of ${producer} is running on it; accept it once that session has stopped`);
  }
  if (!note) return refuse(400, `accepting Todo ${item.id} needs the reason in note: it is posted on the Todo as a comment`);
  return { ok: true, lane: { kind: "parent-owner", employee } };
}

/** The parent's owner accepting a child or sending one back from review. The
 *  ban keys on who produced the work: the child's assignee, or an employee with
 *  a session or start on it. A hand in the child's work leaves the move to the
 *  ordinary agent lane: accepting it is refused as self-review, and moving it
 *  back to executing is the producer's own take-back, not a review bounce. */
function resolveParentOwnerLane(employee: string, item: WorkItem, target: WorkItemStatus, note: string): StatusLaneResult | undefined {
  const producedElsewhere = Boolean(item.assignee) && item.assignee !== employee;
  if (item.status === "executing") return resolveExecutingAccept(employee, item, note);
  const handIn = item.assignee === employee
    ? `${employee} is assigned to it`
    : closerHandIn(employee, item, { producedElsewhere });
  if (handIn) {
    return target === "done"
      ? refuse(403, `${employee} cannot accept Todo ${item.id}: ${handIn}, and an employee never closes its own work (self-review ban); another reviewer or the operator closes it`)
      : undefined;
  }
  if (!note) {
    return refuse(400, target === "done"
      ? `accepting Todo ${item.id} needs the reason in note: it is posted on the Todo as a comment`
      : `sending Todo ${item.id} back needs the feedback in note: it is posted on the Todo as a comment`);
  }
  return { ok: true, lane: { kind: "parent-owner", employee } };
}

/** The comment the gateway posts when an employee's lane closes a Todo as `done`. */
export function employeeCloseComment(lane: StatusLane, note: string): string | undefined {
  if (lane.kind === "closer") return `Closed as done by ${lane.employee}. Reason: ${note}`;
  if (lane.kind === "parent-owner") return `Accepted as done by ${lane.employee}, who owns the parent Todo. Reason: ${note}`;
  return undefined;
}

/** Decide the lane for moving `item` to `target`. `target` is already one of
 *  {@link WORK_ITEM_STATUSES}; `note` is trimmed. */
export function resolveStatusLane(
  caller: WorkItemCaller,
  item: WorkItem,
  target: WorkItemStatus,
  { asOperator, note }: { asOperator: boolean; note: string },
): StatusLaneResult {
  if (hasOperatorLane(caller)) return { ok: true, lane: { kind: "operator" } };
  if (caller.kind !== "session") return refuse(403, "caller has no session identity");
  if (asOperator) return resolveCoordinatorLane(caller, item, target, note);
  const owner = parentOwnerOf(caller, item, target);
  const ownerLane = owner ? resolveParentOwnerLane(owner, item, target, note) : undefined;
  if (ownerLane) return ownerLane;
  const closer = target === "done" ? closerOf(caller) : undefined;
  if (closer) return resolveCloserLane(closer, item, note);
  return resolveAgentLane(item, target, note);
}

/** Every other session: inside the open statuses, and a move into
 *  `in_review` carries the summary the gateway posts. */
function resolveAgentLane(item: WorkItem, target: WorkItemStatus, note: string): StatusLaneResult {
  const closed = STICKY_STATUSES.has(item.status);
  if (target === "done" || target === "cancelled") {
    return refuse(403, `${target === "done" ? "closing" : "cancelling"} Todo ${item.id} is the operator's decision: move it to in_review and the operator closes it`);
  }
  if (closed) return refuse(403, `Todo ${item.id} is ${item.status}; reopening closed work is the operator's`);
  if (!isAgentLaneMove(item.status, target)) {
    return refuse(403, `${item.status} → ${target} is not an agent move on Todo ${item.id}: ${AGENT_LANE_SHAPE}`);
  }
  // Handing work to review is a handoff the operator reads: it carries a
  // summary, which the gateway posts on the Todo as a comment.
  if (target === "in_review" && item.status !== "in_review" && !note) {
    return refuse(400, `moving Todo ${item.id} to in_review needs a summary in note: what was done and where the evidence is; it is posted on the Todo as a comment`);
  }
  return { ok: true, lane: { kind: "agent" } };
}
