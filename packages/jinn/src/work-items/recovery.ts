import { classifyEngineFailureText, hasEngineFailureClass } from "../shared/engine-failure.js";

/**
 * Bounded recovery classification (PLA-240).
 *
 * A verdict here is not an action. The controller decides whether to re-arm,
 * route, or leave the Todo on Needs you. The open run, the approval and the
 * clock arrive as inputs, so the replay suite can feed it history with no DB.
 */

export const RECOVERY_CLASSES = [
  "transient",
  "code",
  "verification",
  "security",
  "operator",
] as const;
export type RecoveryClass = (typeof RECOVERY_CLASSES)[number];

export const ATTENTION_LANES = ["recovering", "manager", "operator"] as const;
export type AttentionLane = (typeof ATTENTION_LANES)[number];

export const TODO_RECOVERY_ACTOR = "todo-recovery";
export const MAX_RECOVERY_ATTEMPTS = 2;
export const EXECUTION_TIMEOUT_MS = 4 * 60 * 60_000;

/** The statuses the recovery sweep visits. A `work_item_recovery` row
 *  describes an incident only while the Todo is in one of these: leaving them —
 *  to `backlog`, or out to a terminal — ends the incident, and the sweep will
 *  never look at the Todo again, so no reader may treat the row as current
 *  outside this set. Without this guard a lane classified while `blocked`
 *  (e.g. a generic operator fallback) outlives the re-queue to backlog. */
export const RECOVERY_SWEPT_STATUSES = ["assigned", "executing", "in_review", "blocked", "escalated"] as const;

export function isRecoverySweptStatus(status: string): boolean {
  return (RECOVERY_SWEPT_STATUSES as readonly string[]).includes(status);
}

const FRESH_RUN_MS = 15 * 60_000;

/** A pipeline between runs, not a stalled one. */
export function runIsFresh(endedAt: string | null | undefined, now: number): boolean {
  return endedAt ? now - Date.parse(endedAt) < FRESH_RUN_MS : false;
}

export const EXECUTING_UNHANDED_REASON = "executing with nothing running for over 4h, and not handed in for review since";

/** Generic fallback: classifyRecovery found no specific incident. */
export const GENERIC_OPERATOR_REASON = "no safe automatic recovery is known";

export function isGenericOperatorFallback(verdict: RecoveryClassification): boolean {
  return verdict.lane === "operator" && verdict.reason === GENERIC_OPERATOR_REASON;
}

/**
 * The recovery sweep is the only writer of a Todo's `work_item_recovery` row,
 * so successive verdicts on it are all this guard has to reconcile.
 * A later generic operator fallback cannot downgrade an unresolved specific
 * lane (manager / recovering). Specific verdicts (failure class, stalled run
 * or assignment, leftover manager, routed approval, operator-only) may
 * replace. Terminal status means the prior condition resolved.
 */
export function mayReplaceRecoveryLane(
  prior: { lane: AttentionLane } | undefined,
  next: RecoveryClassification,
  itemStatus: string,
): boolean {
  if (!prior) return true;
  if (itemStatus === "done" || itemStatus === "cancelled") return true;
  if (isGenericOperatorFallback(next) && prior.lane !== "operator") return false;
  return true;
}

export interface RecoveryClassification {
  class: RecoveryClass;
  lane: AttentionLane;
  reason: string;
  owningWorkflowId?: string;
}

/** Whether any execution attempt is live, when the newest one last moved, and
 *  when the Todo last moved into `executing`. */
export interface AttemptActivity {
  inFlight: boolean;
  lastActivityAt: string | null;
  executingSince: string | null;
}

/**
 * A Todo left in `executing` after its producer stopped. A clean run
 * end no longer hands a reviewed Todo in, and the settle closes its run, so the
 * open-run timeout above never sees it. Past the same 4h budget with nothing
 * live, it goes to Manager attention rather than sitting in the column unseen.
 * The clock starts at whichever is later, the last attempt or the move into
 * `executing`: a review bounce or a re-open gets its own 4h, however long ago
 * the producer last spoke.
 */
export function executingUnhanded(status: string, attempts: AttemptActivity | undefined, now: number): boolean {
  if (status !== "executing" || !attempts || attempts.inFlight || !attempts.lastActivityAt) return false;
  const quietSince = Math.max(Date.parse(attempts.lastActivityAt), Date.parse(attempts.executingSince ?? "") || 0);
  return now - quietSince > EXECUTION_TIMEOUT_MS;
}

export interface RecoveryIncidentInput {
  todo: { id: string; status: string; assignee: string | null; source: string };
  lastRun?: { id: string; outcome: string; error: string | null; endedAt: string | null };
  openRun?: { startedAt: string; sessionInFlight: boolean };
  /** The Todo's linked execution attempts (review and phase links excluded). */
  attempts?: AttemptActivity;
  approval?: { state: string; operatorOnly: boolean };
  verifyMode?: "trust" | "verify" | "thorough";
  owningWorkflowId?: string;
  now?: Date;
}

const AVAILABILITY_CLASSES = ["quota", "rate-limit", "provider-outage", "network"] as const;
const VERIFY_FAILURE = /independent review|verifier rejected|verification failed|review rejected the diff/i;

function verdict(input: RecoveryIncidentInput, value: RecoveryClassification): RecoveryClassification {
  return input.owningWorkflowId === undefined ? value : { ...value, owningWorkflowId: input.owningWorkflowId };
}

function isAvailability(input: RecoveryIncidentInput, error: string): boolean {
  return input.lastRun?.outcome === "rate_limited"
    || hasEngineFailureClass(classifyEngineFailureText(error), ...AVAILABILITY_CLASSES);
}

function isVerificationFailure(input: RecoveryIncidentInput, error: string): boolean {
  return (input.verifyMode === "verify" || input.verifyMode === "thorough") && VERIFY_FAILURE.test(error);
}

function classifyFromFailure(input: RecoveryIncidentInput): RecoveryClassification | undefined {
  const error = input.lastRun?.error ?? "";
  if (hasEngineFailureClass(classifyEngineFailureText(error), "auth-terminal")) {
    return { class: "security", lane: "manager", reason: "credentials or auth failed; a clock retry cannot fix it" };
  }
  if (isAvailability(input, error)) {
    return { class: "transient", lane: "recovering", reason: "provider availability; resume the owning workflow when the window reopens" };
  }
  if (isVerificationFailure(input, error)) {
    return { class: "verification", lane: "manager", reason: "independent verification rejected the work" };
  }
  if (input.lastRun && ["crashed", "failed", "blocked", "timed_out", "abandoned"].includes(input.lastRun.outcome)) {
    return { class: "code", lane: "manager", reason: "the attempt failed in the work itself" };
  }
  return undefined;
}

function classifyStalledExecution(input: RecoveryIncidentInput, now: number): RecoveryClassification | undefined {
  const open = input.openRun;
  if (open && !open.sessionInFlight && now - Date.parse(open.startedAt) > EXECUTION_TIMEOUT_MS) {
    return { class: "code", lane: "manager", reason: "execution has outlived the 4h timeout without an in-flight session to speak for it" };
  }
  if (!open && executingUnhanded("executing", input.attempts, now)) {
    return { class: "operator", lane: "manager", reason: EXECUTING_UNHANDED_REASON };
  }
  return undefined;
}

function classifyStalled(input: RecoveryIncidentInput, status: string, now: number): RecoveryClassification | undefined {
  const open = input.openRun;
  if (status === "executing") return classifyStalledExecution(input, now);
  if (status === "assigned" && input.owningWorkflowId && !open && !runIsFresh(input.lastRun?.endedAt, now)) {
    return { class: "transient", lane: "recovering", reason: "assigned to a pipeline with no active run" };
  }
  return undefined;
}

function classifyLeftover(input: RecoveryIncidentInput, now: number): RecoveryClassification | undefined {
  const state = input.approval?.state;
  const status = input.todo.status;
  if (state === "pending") {
    return { class: "operator", lane: "manager", reason: "a routed approval is waiting on an employee, not the operator" };
  }
  if (status === "in_review" && state === "approved" && input.lastRun?.outcome === "completed") {
    return { class: "operator", lane: "manager", reason: "approved landing is still open" };
  }
  if (status === "in_review" && !input.todo.assignee) {
    return { class: "operator", lane: "manager", reason: "in review with no pending approval and no reviewer" };
  }
  return classifyStalled(input, status, now);
}

export function classifyRecovery(input: RecoveryIncidentInput): RecoveryClassification {
  if (input.todo.status === "backlog") {
    return verdict(input, { class: "operator", lane: "operator", reason: "ordinary backlog work is never auto-started" });
  }
  if (input.approval?.state === "pending" && input.approval.operatorOnly) {
    return verdict(input, { class: "operator", lane: "operator", reason: "operator-only approval is a genuine authority decision" });
  }
  const fromFailure = classifyFromFailure(input);
  if (fromFailure) return verdict(input, fromFailure);
  const leftover = classifyLeftover(input, (input.now ?? new Date()).getTime());
  if (leftover) return verdict(input, leftover);
  return verdict(input, { class: "operator", lane: "operator", reason: GENERIC_OPERATOR_REASON });
}

/** Additive: never a column on `work_items`. The exact-shape verifier refuses
 *  drift in an existing table, so a new table is the only extension a deployed
 *  database can survive. */
export const WORK_ITEM_RECOVERY_DDL = `
CREATE TABLE IF NOT EXISTS work_item_recovery (
  work_item_id     TEXT PRIMARY KEY REFERENCES work_items(id) ON DELETE CASCADE,
  incident_id      TEXT NOT NULL,
  class            TEXT NOT NULL CHECK (class IN ('transient','code','verification','security','operator')),
  lane             TEXT NOT NULL CHECK (lane IN ('recovering','manager','operator')),
  attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 2),
  last_attempt_at  TEXT,
  last_run_id      TEXT,
  reason           TEXT NOT NULL,
  updated_at       TEXT NOT NULL
)`;

export const WORK_ITEM_RECOVERY_TABLES: ReadonlyArray<{ name: string; ddl: string }> = [
  { name: "work_item_recovery", ddl: WORK_ITEM_RECOVERY_DDL },
];

export interface WorkItemRecovery {
  workItemId: string;
  incidentId: string;
  class: RecoveryClass;
  lane: AttentionLane;
  attempts: number;
  lastAttemptAt: string | null;
  lastRunId: string | null;
  reason: string;
  updatedAt: string;
}

export interface UpsertRecoveryInput {
  workItemId: string;
  incidentId: string;
  class: RecoveryClass;
  lane: AttentionLane;
  reason: string;
  lastRunId?: string | null;
  /** When true, increment attempts for the same incident (capped at 2). A new
   *  incident_id starts at 0. */
  attempted?: boolean;
  now?: Date;
}
