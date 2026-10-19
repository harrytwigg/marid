import { getSession, isCoordinatorSession } from "../sessions/registry.js";
import { listWorkItemEvents } from "../work-items/event-log.js";
import { toWorkItemLinkRole } from "../work-items/link-role.js";
import { STICKY_STATUSES, type WorkItem, type WorkItemEvent, type WorkItemStatus } from "../work-items/store.js";
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
 *   the gateway posts on the Todo. Nothing else rides on it.
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
  | { kind: "coordinator"; actingAs: string }
  | { kind: "closer"; employee: string }
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

/** `asOperator` from a session: the coordinator closing a Todo as `done` for
 *  the operator, with the reason it will post. Nothing else rides on it. */
function resolveCoordinatorLane(
  caller: Extract<WorkItemCaller, { kind: "session" }>,
  item: WorkItem,
  target: WorkItemStatus,
  note: string,
): StatusLaneResult {
  if (!isCoordinatorSession(caller.session)) {
    const who = caller.session.employee ? `employee "${caller.session.employee}"` : `session ${caller.callerId}`;
    return refuse(403, `asOperator is reserved for the operator's coordinator session; ${who} moves Todo ${item.id} as itself`);
  }
  if (target !== "done") {
    return refuse(403, "asOperator closes a Todo as done for the operator and nothing else: cancelling, archiving and reopening stay with the operator");
  }
  if (STICKY_STATUSES.has(item.status)) return refuse(403, `Todo ${item.id} is already ${item.status}; reopening closed work is the operator's`);
  if (!note) {
    return refuse(400, "asOperator needs the reason in note: closing a Todo for the operator is for exceptional cases, and the reason is posted on the Todo");
  }
  return { ok: true, lane: { kind: "coordinator", actingAs: workItemActor(caller) } };
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
function closerHandIn(employee: string, item: WorkItem): string | undefined {
  const events = listWorkItemEvents(item.id);
  if (events.some((event) => workedBy(event, employee))) return `a session of ${employee} was linked to work on it`;
  if (events.some((event) => startedBy(event, employee))) return `${employee} moved it to executing`;
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
