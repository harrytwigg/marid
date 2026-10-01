import { isCoordinatorSession } from "../sessions/registry.js";
import { STICKY_STATUSES, type WorkItem, type WorkItemStatus } from "../work-items/store.js";
import { isAgentLaneMove } from "../work-items/transition-edges.js";
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
 *   cancels or reopens.
 * - The **coordinator lane** is the one exception: the operator's coordinator
 *   chat may close a Todo as `done` on the operator's behalf, with a reason
 *   the gateway posts on the Todo. Nothing else rides on it.
 */

export const WORK_ITEM_STATUSES: readonly WorkItemStatus[] = ["backlog", "executing", "in_review", "done", "blocked", "cancelled"];

/** What an agent session may set. `backlog` is "not now": an agent that picked
 *  a Todo up and found it premature can put it back down. */
export const AGENT_WORK_ITEM_TARGETS: readonly WorkItemStatus[] = ["backlog", "executing", "in_review", "blocked"];

export type StatusLane =
  | { kind: "operator" }
  | { kind: "coordinator"; actingAs: string }
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
  const closed = STICKY_STATUSES.has(item.status);
  if (asOperator) {
    if (!isCoordinatorSession(caller.session)) {
      const who = caller.session.employee ? `employee "${caller.session.employee}"` : `session ${caller.callerId}`;
      return refuse(403, `asOperator is reserved for the operator's coordinator session; ${who} moves Todo ${item.id} as itself`);
    }
    if (target !== "done") {
      return refuse(403, "asOperator closes a Todo as done for the operator and nothing else: cancelling, archiving and reopening stay with the operator");
    }
    if (closed) return refuse(403, `Todo ${item.id} is already ${item.status}; reopening closed work is the operator's`);
    if (!note) {
      return refuse(400, "asOperator needs the reason in note: closing a Todo for the operator is for exceptional cases, and the reason is posted on the Todo");
    }
    return { ok: true, lane: { kind: "coordinator", actingAs: workItemActor(caller) } };
  }
  if (target === "done" || target === "cancelled") {
    return refuse(403, `${target === "done" ? "closing" : "cancelling"} Todo ${item.id} is the operator's decision: move it to in_review and the operator closes it`);
  }
  if (closed) return refuse(403, `Todo ${item.id} is ${item.status}; reopening closed work is the operator's`);
  if (!isAgentLaneMove(item.status, target)) {
    return refuse(403, `${item.status} → ${target} is not an agent move on Todo ${item.id}: ${AGENT_LANE_SHAPE}`);
  }
  return { ok: true, lane: { kind: "agent" } };
}
