import { initDb } from "../shared/db.js";
import { getTodoDispatchConfig } from "./dispatch-config.js";
import { OPERATOR_ASSIGNEE } from "./operator-assignee.js";
import type { WorkItemStatus } from "./store.js";

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
  /** Backlog children the walk will not start (`autoStart` off, or the operator's). */
  notStarting: string[];
}

/** The same per-Todo opt-outs the board walk reads (`noAutoStartReason`), less the
 *  start-date hold: a child scheduled for later is part of the plan. */
function walkWillStart(child: { id: string; assignee: string | null }): boolean {
  return getTodoDispatchConfig(child.id)?.autoStart !== false && child.assignee !== OPERATOR_ASSIGNEE;
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
