import { IDLE_CAPACITY_OPT_OUT_LABEL, type IdleCapacityPolicy } from "../shared/idle-capacity-config.js";
import { listWorkItems, type WorkItem } from "../work-items/store.js";
import { getWorkItemLabels, normalizeLabelName } from "../work-items/labels.js";
import { getTodoDispatchConfig } from "../work-items/dispatch-config.js";
import { OPERATOR_ASSIGNEE } from "../work-items/assignment.js";

/**
 * Which backlog Todos the idle-capacity auto-start may start, and in
 * what order. Kept apart from the loop so the eligibility rules read as one
 * list and test as one unit.
 */

export interface Skipped {
  workItemId: string;
  reason: string;
}

function labelReason(item: WorkItem, required: string | null): string | undefined {
  const labels = new Set(getWorkItemLabels(item.id).map((label) => label.name));
  if (labels.has(IDLE_CAPACITY_OPT_OUT_LABEL)) return `label ${IDLE_CAPACITY_OPT_OUT_LABEL}`;
  if (required && !labels.has(required)) return `no ${required} label`;
  return undefined;
}

function dispatchReason(item: WorkItem): string | undefined {
  const dispatch = getTodoDispatchConfig(item.id);
  if (dispatch?.autoStart === false) return "autoStart is false";
  // The whole point of a start here is to spend Claude allowance. A Todo whose
  // next attempt is pinned to another engine would spend that engine's money
  // instead and leave the Claude window to lapse exactly as before.
  if (dispatch?.engine && dispatch.engine !== "claude") return `dispatch override names engine ${dispatch.engine}`;
  return undefined;
}

/** Why a backlog Todo is passed over, or undefined when it may be started. */
function skipReason(item: WorkItem, required: string | null): string | undefined {
  const early = labelReason(item, required) ?? dispatchReason(item);
  if (early) return early;
  // The operator holds it: their own work, not spare capacity's to start.
  if (item.assignee === OPERATOR_ASSIGNEE) return "assigned to the operator";
  return undefined;
}

/**
 * Backlog Todos this loop may start, best first. A backlog Todo is skipped
 * when it says so (opt-out label, `autoStart: false`), when its next attempt
 * is pinned to a non-Claude engine, when the operator is its assignee, or when the policy requires a label it does not
 * carry. Priority 3 is "High", so higher first; then the oldest, which has
 * waited longest.
 *
 * A parked Todo never reaches this list, so there is no rule for it here
 *. Parking is `blocked` plus `parkedUntil`, and leaving `blocked`
 * deletes the park, so a `backlog` Todo cannot carry one; the old check here
 * could never fire. When the date passes the work-item reconciler re-queues the
 * Todo (`park-expiry.ts`), and only then does it become a candidate.
 */
export function eligibleBacklog(policy: IdleCapacityPolicy): { eligible: WorkItem[]; skipped: Skipped[] } {
  const required = policy.requireLabel ? normalizeLabelName(policy.requireLabel) : null;
  const skipped: Skipped[] = [];
  const eligible: WorkItem[] = [];
  for (const item of listWorkItems({ status: "backlog" })) {
    const reason = skipReason(item, required);
    if (reason) skipped.push({ workItemId: item.id, reason });
    else eligible.push(item);
  }
  eligible.sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return { eligible, skipped };
}
