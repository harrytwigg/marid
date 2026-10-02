import { getWorkItemRecovery, upsertWorkItemRecovery } from "./recovery-rows.js";
import {
  classifyRecovery,
  mayReplaceRecoveryLane,
  MAX_RECOVERY_ATTEMPTS,
  RECOVERY_SWEPT_STATUSES,
  TODO_RECOVERY_ACTOR,
  type AttemptActivity,
  type RecoveryClassification,
} from "./recovery.js";
import { isExecutionAttempt } from "./link-role.js";
import { listWorkItemAttemptRuns } from "./runs.js";
import { listWorkItemEvents } from "./event-log.js";
import { appendWorkItemEvent, listWorkItems, type WorkItem } from "./store.js";
import { initDb } from "../shared/db.js";
import { listSessionsByWorkItem } from "../sessions/registry.js";
import { hasLiveBackgroundWork } from "../sessions/background-work.js";
import type { AvailabilityRearmResult } from "./availability-resume.js";

export type TodoRecoveryMode = "off" | "classify-only" | "auto";

export interface RecoveryApplyDeps {
  mode: TodoRecoveryMode;
  now?: () => Date;
  /** Restart the Todo's work. The restart takes the Todo's claim itself, so
   *  the sweep must not hold one around the call. */
  rearm(todoId: string): AvailabilityRearmResult;
}

export interface RecoverySweepResult {
  classified: number;
  applied: number;
}

/** The one definition lives beside the classification (`recovery.ts`), because
 *  the payload reader also has to know which statuses a recovery row is current
 *  for — two lists would drift. */
const SWEEP_STATUSES = RECOVERY_SWEPT_STATUSES;

export function todoRecoveryMode(raw: string | undefined): TodoRecoveryMode {
  return raw === "off" || raw === "auto" || raw === "classify-only" ? raw : "classify-only";
}

/** A session stored idle whose background sub-agents are still working is in
 *  flight too: its turn ended, its work did not. */
export function sessionInFlight(sessionId: string): boolean {
  const row = initDb().prepare("SELECT status FROM sessions WHERE id = ?").get(sessionId) as { status: string } | undefined;
  return row?.status === "running" || row?.status === "waiting" || (row?.status === "idle" && hasLiveBackgroundWork(sessionId));
}

/** Newest-first, as the registry lists them; review links never count. */
export function attemptActivity(workItemId: string): AttemptActivity {
  const attempts = listSessionsByWorkItem(workItemId).filter(isExecutionAttempt);
  return {
    inFlight: attempts.some((session) => session.status === "running" || session.status === "waiting"
      || (session.status === "idle" && hasLiveBackgroundWork(session.id))),
    lastActivityAt: attempts[0]?.lastActivity ?? null,
    executingSince: listWorkItemEvents(workItemId)
      .filter((event) => event.kind === "status_change" && event.toStatus === "executing").at(-1)?.createdAt ?? null,
  };
}

export function classifyWorkItem(item: WorkItem, now = new Date()): RecoveryClassification {
  const runs = listWorkItemAttemptRuns(item.id);
  const last = [...runs].reverse().find((run) => run.endedAt !== null);
  const open = runs.find((run) => run.endedAt === null);
  return classifyRecovery({
    todo: { id: item.id, status: item.status, assignee: item.assignee, source: item.source },
    lastRun: last
      ? { id: last.id, outcome: last.outcome ?? "crashed", error: last.error, endedAt: last.endedAt }
      : undefined,
    openRun: open ? { startedAt: open.startedAt, sessionInFlight: sessionInFlight(open.sessionId) } : undefined,
    attempts: item.status === "executing" ? attemptActivity(item.id) : undefined,
    now,
  });
}

function incidentId(item: WorkItem, lastRunId: string | undefined): string {
  return lastRunId ?? `status:${item.id}:${item.status}:${item.updatedAt}`;
}

function recordClassified(item: WorkItem, verdict: RecoveryClassification, lastRunId: string | undefined, now: Date): void {
  const prior = getWorkItemRecovery(item.id);
  const id = incidentId(item, lastRunId);
  if (prior?.incidentId === id && prior.class === verdict.class && prior.lane === verdict.lane) return;
  if (!mayReplaceRecoveryLane(prior, verdict, item.status)) return;
  upsertWorkItemRecovery({
    workItemId: item.id,
    incidentId: id,
    class: verdict.class,
    lane: verdict.lane,
    reason: verdict.reason,
    lastRunId,
    now,
  });
  appendWorkItemEvent({
    workItemId: item.id,
    kind: "recovery_classified",
    actor: TODO_RECOVERY_ACTOR,
    detail: { class: verdict.class, lane: verdict.lane, incidentId: id, reason: verdict.reason },
    versionEffect: "audit",
  });
}

function applyCodeRepair(item: WorkItem, deps: RecoveryApplyDeps, lastRunId: string | undefined, now: Date): boolean {
  const prior = getWorkItemRecovery(item.id);
  const id = incidentId(item, lastRunId);
  if ((prior?.incidentId === id ? prior.attempts : 0) >= MAX_RECOVERY_ATTEMPTS) {
    upsertWorkItemRecovery({
      workItemId: item.id, incidentId: id, class: "code", lane: "manager",
      reason: "automatic repair attempts exhausted", lastRunId, now,
    });
    appendWorkItemEvent({
      workItemId: item.id, kind: "recovery_exhausted", actor: TODO_RECOVERY_ACTOR,
      detail: { incidentId: id, attempts: MAX_RECOVERY_ATTEMPTS }, versionEffect: "audit",
    });
    return false;
  }
  if (listWorkItemAttemptRuns(item.id).some((run) => run.endedAt === null)) return false;
  const landed = deps.rearm(item.id);
  if ("unavailable" in landed) return false;
  upsertWorkItemRecovery({
    workItemId: item.id, incidentId: id, class: "code", lane: "manager",
    reason: "scoped repair re-dispatched the Todo", lastRunId, attempted: true, now,
  });
  appendWorkItemEvent({
    workItemId: item.id, kind: "recovery_attempted", actor: TODO_RECOVERY_ACTOR,
    detail: { incidentId: id, class: "code", status: landed.status }, versionEffect: "audit",
  });
  return true;
}

/**
 * One pass over open Todos, and the only writer of `work_item_recovery`.
 * Classify-only writes lanes and audit; auto additionally re-arms code failures
 * (transients stay with the availability sweep). Backlog is never listed.
 */
function recoverOne(item: WorkItem, deps: RecoveryApplyDeps, now: Date): { classified: boolean; applied: boolean } {
  const verdict = classifyWorkItem(item, now);
  const lastRunId = [...listWorkItemAttemptRuns(item.id)].reverse().find((run) => run.endedAt !== null)?.id;
  const before = getWorkItemRecovery(item.id);
  recordClassified(item, verdict, lastRunId, now);
  const classified = !before || before.incidentId !== incidentId(item, lastRunId) || before.lane !== verdict.lane;
  const applied = deps.mode === "auto" && verdict.class === "code" && applyCodeRepair(item, deps, lastRunId, now);
  return { classified, applied };
}

export function sweepTodoRecovery(deps: RecoveryApplyDeps): RecoverySweepResult {
  if (deps.mode === "off") return { classified: 0, applied: 0 };
  const now = deps.now?.() ?? new Date();
  let classified = 0;
  let applied = 0;
  for (const status of SWEEP_STATUSES) {
    for (const item of listWorkItems({ status })) {
      const result = recoverOne(item, deps, now);
      if (result.classified) classified++;
      if (result.applied) applied++;
    }
  }
  return { classified, applied };
}
