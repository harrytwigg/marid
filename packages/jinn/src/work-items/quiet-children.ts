import { initDb } from "../shared/db.js";
import { getTodoDispatchConfig } from "./dispatch-config.js";
import { OPERATOR_ASSIGNEE } from "./operator-assignee.js";
import { getWorkItem, type WorkItemStatus } from "./store.js";
import { todoHoldRefusal } from "./todo-hold.js";

/**
 * What a Todo's open children say about its quiet. An orchestrator that split
 * its work and ended its turn is waiting, not stalled, while a child is being
 * worked or sits in `backlog` for the board walk to start. A child the walk will
 * never start, or one that has settled and waits on the parent, is the parent's
 * to act on, and the nudge names it.
 */

export interface ChildWork {
  /** A child is executing, or in backlog where the board walk will start it. */
  waiting: boolean;
  /** Children in `in_review` or `blocked`: handed back, waiting on the parent. */
  settled: Array<{ id: string; status: WorkItemStatus }>;
  /** Backlog children the walk will not start (`autoStart` off, the operator's, or held outside its assignee's department). */
  notStarting: string[];
}

/** The refusals the board walk applies to a backlog Todo (`noAutoStartReason`):
 *  `autoStart` off, the operator's, and a department hold on the assignee. The
 *  start-date hold (`startDateHold`) and an exhausted account are left out on
 *  purpose: both pass with time, so such a child is still part of the plan and
 *  counts as waiting. */
function walkWillStart(child: { id: string; assignee: string | null }): boolean {
  if (getTodoDispatchConfig(child.id)?.autoStart === false || child.assignee === OPERATOR_ASSIGNEE) return false;
  const item = getWorkItem(child.id);
  return !item || todoHoldRefusal(item) === null;
}

export function childWork(workItemId: string): ChildWork {
  const children = initDb()
    .prepare("SELECT id, status, assignee FROM work_items WHERE parent_id = ? AND status NOT IN ('done', 'cancelled') ORDER BY id")
    .all(workItemId) as Array<{ id: string; status: WorkItemStatus; assignee: string | null }>;
  const work: ChildWork = { waiting: false, settled: [], notStarting: [] };
  for (const child of children) {
    if (child.status === "executing" || (child.status === "backlog" && walkWillStart(child))) work.waiting = true;
    else if (child.status === "backlog") work.notStarting.push(child.id);
    else work.settled.push({ id: child.id, status: child.status });
  }
  return work;
}
