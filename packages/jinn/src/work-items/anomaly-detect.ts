import { currentApproval } from "./approval-rows.js";
import { listWorkItemEvents } from "./event-log.js";
import { attemptActivity, classifyWorkItem, sessionInFlight } from "./recovery-controller.js";
import { getWorkItemRecovery } from "./recovery-rows.js";
import {
  EXECUTING_UNHANDED_REASON, EXECUTION_TIMEOUT_MS, executingUnhanded, TODO_RECOVERY_ACTOR, type AttentionLane,
} from "./recovery.js";
import { listWorkItemAttemptRuns } from "./runs.js";
import { appendWorkItemEvent, getWorkItem, listWorkItems, type WorkItem } from "./store.js";

export const ANOMALY_KINDS = [
  "execution-timeout",
  "executing-unhanded",
  "review-without-reviewer",
  "blocked-without-recovery",
] as const;
export type AnomalyKind = (typeof ANOMALY_KINDS)[number];

export interface TodoAnomaly {
  workItemId: string;
  kind: AnomalyKind;
  lane: AttentionLane;
  reason: string;
}

/** One `anomaly_observed` per Todo per kind: the audit records the lie, not the tick. */
function observe(item: WorkItem, anomaly: TodoAnomaly): void {
  if (listWorkItemEvents(item.id).some((e) => e.kind === "anomaly_observed" && e.detail?.kind === anomaly.kind)) return;
  appendWorkItemEvent({
    workItemId: item.id, kind: "anomaly_observed", actor: TODO_RECOVERY_ACTOR,
    detail: { kind: anomaly.kind, lane: anomaly.lane, reason: anomaly.reason }, versionEffect: "audit",
  });
}

function executionTimeout(item: WorkItem, now: Date): TodoAnomaly | undefined {
  if (item.status !== "executing") return undefined;
  const open = listWorkItemAttemptRuns(item.id).find((run) => run.endedAt === null);
  if (!open) {
    // A pending approval is a question already on somebody's queue, not a stall.
    if (currentApproval(item.id)?.state === "pending") return undefined;
    if (!executingUnhanded(item.status, attemptActivity(item.id), now.getTime())) return undefined;
    return { workItemId: item.id, kind: "executing-unhanded", lane: "manager", reason: EXECUTING_UNHANDED_REASON };
  }
  if (sessionInFlight(open.sessionId)) return undefined;
  if (!(now.getTime() - Date.parse(open.startedAt) > EXECUTION_TIMEOUT_MS)) return undefined;
  return { workItemId: item.id, kind: "execution-timeout", lane: "manager", reason: "execution has outlived the 4h timeout without an in-flight session to speak for it" };
}

function reviewAnomaly(item: WorkItem): TodoAnomaly | undefined {
  if (item.status !== "in_review") return undefined;
  const approval = currentApproval(item.id);
  if (approval?.state !== "pending" && !item.assignee) {
    return { workItemId: item.id, kind: "review-without-reviewer", lane: "manager", reason: "in review with no pending approval and no reviewer" };
  }
  return undefined;
}

function blockedWithoutRecovery(item: WorkItem): TodoAnomaly | undefined {
  if (item.status !== "blocked" || getWorkItemRecovery(item.id)) return undefined;
  const verdict = classifyWorkItem(item);
  if (verdict.lane === "operator") return undefined;
  return { workItemId: item.id, kind: "blocked-without-recovery", lane: verdict.lane, reason: "blocked with no recovery row" };
}

function inspect(item: WorkItem, now: Date): TodoAnomaly | undefined {
  return executionTimeout(item, now) ?? reviewAnomaly(item) ?? blockedWithoutRecovery(item);
}

export interface DetectTodoAnomaliesInput {
  now?: Date;
  /** When false, detect without appending the `anomaly_observed` audit event. */
  persist?: boolean;
}

/**
 * Quiet detector. Returns the leftover lies on the board. A healthy board
 * returns []. Never creates a Todo, a session, or a recovery row — the sweep
 * owns that row; this only appends the audit trail.
 */
export function detectTodoAnomalies(input: DetectTodoAnomaliesInput = {}): TodoAnomaly[] {
  const now = input.now ?? new Date();
  const persist = input.persist !== false;
  const found: TodoAnomaly[] = [];
  for (const status of ["assigned", "executing", "in_review", "blocked"] as const) {
    for (const item of listWorkItems({ status })) {
      const anomaly = inspect(item, now);
      if (!anomaly) continue;
      found.push(anomaly);
      if (persist) observe(item, anomaly);
    }
  }
  return found;
}

export function detectAnomalyFor(id: string, now = new Date()): TodoAnomaly | undefined {
  const item = getWorkItem(id);
  return item ? inspect(item, now) : undefined;
}
