import { loadConfig } from "../shared/config.js";
import { initDb } from "../shared/db.js";
import { logger } from "../shared/logger.js";
import type { JsonObject, Session } from "../shared/types.js";
import { deliverClaimedSessionDelivery } from "./callbacks.js";
import {
  RESTART_ACK_META_KEY,
  RESTART_RESUME_META_KEY,
  RESTART_RESUME_REASON_META_KEY,
  RESTART_REQUESTER_LOOP_GUARD_MS,
  RESTART_REQUESTER_LOOP_GUARD_NUDGES,
  claimSessionDelivery,
  consumeRestartAcknowledgements,
  ensureCallbackAttemptToken,
  getSession,
  isStaleRestartAcknowledgement,
  listAllRunningSessions,
  listIdleRestartRequesters,
  stampRestartRequesterNudged,
  updateSession,
} from "./registry.js";
import { recordRestartInterruption, recordRestartResume, type RestartRecordGateway } from "./restart-record.js";

/**
 * A restart can strand any number of conversational sessions at once. Waking
 * them all in the same tick spawns that many engine processes simultaneously,
 * which is exactly the moment a rate-limited primary engine starts refusing —
 * so the tail is capped and the rest are spaced far enough apart that later
 * nudges land on the fallback chain instead of failing together.
 */
export const MAX_RESTART_RESUMES = 10;
export const RESTART_RESUME_STAGGER_MS = 15_000;

const RESTART_RESUME_DELIVERY_KIND = "gateway-restart-resume";
const RESTART_RESUME_SOURCE_OUTCOME = "gateway-restart";

export interface RestartResume {
  sessionId: string;
  dueAt: number;
}

export interface RestartResumePlan {
  resumes: RestartResume[];
  /** Candidates over the cap. Reported so a busy restart is visible in the log
   *  rather than silently losing the oldest sessions. */
  deferred: RestartResume["sessionId"][];
}

/**
 * Why a marked session is owed a nudge — each gets its own wording, because
 * each has a different thing to re-check:
 * - `interrupted`: a turn was in flight and the restart cut it short.
 * - `requested`: the session asked for the restart itself. Whatever
 *   it was waiting on to learn the outcome died with its engine process.
 * - `background`: it was idle, but waiting on background work (a background
 *   Bash task, a background agent) that the restart killed.
 */
export type RestartResumeReason = "interrupted" | "requested" | "background";

export interface RestartResumeCandidate {
  session: Session;
  reason: RestartResumeReason;
  /** The mark's timestamp: when the restart interrupted it, or when it asked for the restart. */
  markedAt: string;
}

/** A session idle at shutdown whose engine still reported background work, and what that work was. */
export interface BackgroundWorkAtShutdown {
  sessionId: string;
  detail: string;
}

/** The slice of an engine's post-settle runtime activity the shutdown reads. */
export interface BackgroundActivityCounts {
  activeStreams: number;
  activeAgents?: number;
  activeMonitors?: number;
  backgroundAgents?: number;
  backgroundRerun?: boolean;
}

/** Sessions whose engine still reports post-settle work: a background Bash task or sub-agent it
 *  has not seen finish, a background re-run, or an agent request in flight after the turn settled. A shutdown kills that work
 *  with the engine process, so these are owed a resume nudge. Auxiliary requests
 *  (titles, token counts) are not work anyone waits on, so an engine that classifies its
 *  streams is judged on agents alone. */
export function backgroundWorkAtShutdown(activity: ReadonlyMap<string, BackgroundActivityCounts>): BackgroundWorkAtShutdown[] {
  const waiting: BackgroundWorkAtShutdown[] = [];
  for (const [sessionId, info] of activity) {
    const detail = describeBackgroundWork(info);
    if (detail) waiting.push({ sessionId, detail });
  }
  return waiting;
}

function counted(n: number, noun: string): string[] {
  return n > 0 ? [`${n} ${noun}${n === 1 ? "" : "s"}`] : [];
}

/** The work a session's post-settle activity describes, or undefined for none. */
function describeBackgroundWork(info: BackgroundActivityCounts): string | undefined {
  const parts = [
    ...counted(info.activeMonitors ?? 0, "background task"),
    // A sub-agent between model requests (running a tool) has none in flight.
    ...counted(info.backgroundAgents ?? 0, "background sub-agent"),
    ...counted(info.activeAgents ?? info.activeStreams, "background agent request"),
    ...(info.backgroundRerun === true ? ["a background re-run"] : []),
  ];
  return parts.length > 0 ? parts.join(" and ") : undefined;
}

export interface RestartShutdownOptions {
  /** Idle sessions with live background work, read from the engines' runtime activity. */
  backgroundWork?: () => BackgroundWorkAtShutdown[];
}

export interface RestartResumeCandidates {
  /** Marked sessions this boot must nudge. */
  resumable: RestartResumeCandidate[];
  /** Marked sessions a pending queue item already re-drives, so `resumePendingWebQueueItems` resumes them instead. */
  replaying: Session[];
}

export type RestartNudgeResult =
  | { claimed: true; deliveryId: string }
  | { claimed: false; reason: "no-attempt-token" | "already-nudged" | "already-delivered" };

/** Meta-table key the shutting-down gateway leaves behind once it has recorded every
 *  running session, so the next boot knows the record is already written. */
const RESTART_SHUTDOWN_RECEIPT_KEY = "restart.shutdown_recorded_by";

/**
 * Preserve running conversational Sessions for resume, and write every running
 * session to the restart record so the set survives the boot that consumes the
 * marks. Two kinds of session that are not `running` are owed a resume too, and
 * are recorded here: the ones that asked for this restart (the next
 * boot stamps them from their acknowledgement), and the idle ones still waiting
 * on background work that this shutdown is about to kill. A phase row left by
 * the removed Workflow runtime is skipped: nothing resumes it, and the boot
 * sweep (`settleLegacyWorkflowPhaseSessions`) settles it. The receipt written
 * last tells the next boot not to record the shutdown again as a crash.
 * Exported as a shutdown test seam.
 */
export function interruptRunningSessionsForShutdown(gateway: RestartRecordGateway, options: RestartShutdownOptions = {}): void {
  // Read before the sweep below, which sets a running requester idle: it records that one itself.
  const idleRequesters = listIdleRestartRequesters();
  for (const { session, workflowAttempt } of listAllRunningSessions()) {
    const now = new Date().toISOString();
    if (workflowAttempt) continue;
    if (hasRestartAcknowledgement(session)) {
      updateSession(session.id, {
        status: "idle",
        attemptOutcome: "interrupted",
        lastActivity: now,
        lastError: null,
      });
      recordRestartInterruption(gateway, session, "shutdown", "restart-notice");
      logger.info(`Left restart-requesting session ${session.id} idle during gateway shutdown`);
      continue;
    }
    updateSession(session.id, {
      status: "interrupted",
      attemptOutcome: "interrupted",
      lastActivity: now,
      lastError: "Interrupted: gateway shutting down gracefully",
      transportMeta: { ...existingTransportMeta(session), [RESTART_RESUME_META_KEY]: now },
    });
    recordRestartInterruption(gateway, session, "shutdown", "restart-resume");
    logger.info(`Marked session ${session.id} as interrupted for resume`);
  }
  for (const session of idleRequesters) {
    recordRestartInterruption(gateway, session, "shutdown", "restart-notice");
    logger.info(`Recorded idle restart-requesting session ${session.id} for the restart notice and resume nudge`);
  }
  markBackgroundWorkForResume(gateway, options.backgroundWork?.() ?? []);
  initDb().prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(RESTART_SHUTDOWN_RECEIPT_KEY, gateway.bootId);
}

/**
 * Stamp idle sessions whose background work is about to die with the engine
 * processes. The session row is left `idle` — its last turn did finish — so
 * only the resume mark changes. Runs after the running sweep, so a session that
 * sweep already marked (or left alone as a requester) is never stamped twice.
 * Only `idle` rows qualify: a `waiting` row is paused mid-turn on a rate limit,
 * so "your turn had finished" would be the wrong thing to tell it. A stale
 * acknowledgement does not make a session a requester of this restart, so it
 * does not exclude it either.
 */
function markBackgroundWorkForResume(gateway: RestartRecordGateway, waiting: BackgroundWorkAtShutdown[]): void {
  if (waiting.length === 0) return;
  const database = initDb();
  const eligible = database.prepare(
    `SELECT json_extract(transport_meta, '$.${RESTART_ACK_META_KEY}') AS acknowledged_at FROM sessions
       WHERE id = ? AND status = 'idle' AND workflow_kind IS NULL
       AND json_type(transport_meta, '$.${RESTART_RESUME_META_KEY}') IS NULL`,
  );
  const stamp = database.prepare(
    `UPDATE sessions SET transport_meta = json_set(COALESCE(transport_meta, '{}'), '$.${RESTART_RESUME_META_KEY}', ?, '$.${RESTART_RESUME_REASON_META_KEY}', 'background') WHERE id = ?`,
  );
  for (const { sessionId, detail } of waiting) {
    const row = eligible.get(sessionId) as { acknowledged_at: unknown } | undefined;
    if (!row) continue;
    if (row.acknowledged_at != null && !isStaleRestartAcknowledgement(row.acknowledged_at)) continue;
    stamp.run(new Date().toISOString(), sessionId);
    const session = getSession(sessionId);
    if (!session) continue;
    recordRestartInterruption(gateway, session, "shutdown", "restart-resume", `waiting on ${detail}`);
    logger.info(`Marked idle session ${sessionId} for resume: it was waiting on ${detail}`);
  }
}

/**
 * Boot step, before the listener opens to sessions: post the restart notice in
 * every session that asked for this restart, stamp it for the resume nudge, and
 * record the ones the requester guards hold back. Returns how many notices it
 * posted.
 */
export function acknowledgeRestartRequesters(gateway: RestartRecordGateway): number {
  const acknowledged = consumeRestartAcknowledgements();
  for (const { sessionId, acknowledgedAt, resume } of acknowledged) {
    if (resume === "nudge") continue;
    const session = getSession(sessionId);
    const why = resume === "loop-guard"
      ? `it was already nudged back from ${RESTART_REQUESTER_LOOP_GUARD_NUDGES} of its own restarts in the last ${RESTART_REQUESTER_LOOP_GUARD_MINUTES} minutes`
      : `its restart request (${acknowledgedAt}) is older than this restart`;
    if (session) recordRestartResume(gateway, session, resume, why);
    logger.warn(`Restart-requesting session ${sessionId} gets the restart notice but no resume nudge: ${why}`);
  }
  return acknowledged.length;
}

/**
 * Boot step, before the recovery sweeps settle anything: write the sessions the
 * previous gateway did not get to record itself. With a shutdown receipt, that
 * is only a conversational row that slipped past the shutdown marking (a turn
 * that started during the drain). Without one, the old process died mid-flight
 * (kill, crash, power) and this boot is the first to know about every row.
 * Phase rows left by the removed Workflow runtime are never recorded: nothing
 * resumes them, and the boot sweep settles them.
 */
export function recordSessionsRunningAtBoot(gateway: RestartRecordGateway): { recorded: Session[]; cleanShutdownBootId: string | null } {
  const cleanShutdownBootId = consumeRestartShutdownReceipt();
  const running = listAllRunningSessions();
  const unrecorded = running.filter((row) => !row.workflowAttempt);
  for (const { session } of unrecorded) {
    recordRestartInterruption(gateway, session, "stale-on-boot", "restart-resume");
  }
  return { recorded: unrecorded.map((row) => row.session), cleanShutdownBootId };
}

/** Take the previous gateway's shutdown receipt, exactly once. */
function consumeRestartShutdownReceipt(): string | null {
  const database = initDb();
  return database.transaction(() => {
    const row = database.prepare("SELECT value FROM meta WHERE key = ?").get(RESTART_SHUTDOWN_RECEIPT_KEY) as { value: string } | undefined;
    if (!row) return null;
    database.prepare("DELETE FROM meta WHERE key = ?").run(RESTART_SHUTDOWN_RECEIPT_KEY);
    return row.value;
  }).immediate();
}

/**
 * Take the sessions this gateway's own restart interrupted, exactly once.
 * Selecting the marks and clearing them share one transaction, so a second boot
 * can never re-fire the first restart's nudges.
 *
 * Every mark is cleared, including the ones in `replaying`: a session whose turn
 * `resumePendingWebQueueItems` already re-dispatched is resumed, just not by us,
 * and leaving its mark behind would turn it into a nudge on some later restart it
 * had nothing to do with. They are returned rather than dropped so the restart
 * record can say which path brought each session back.
 */
export function consumeRestartResumeCandidates(): RestartResumeCandidates {
  const database = initDb();
  const jsonPath = `$.${RESTART_RESUME_META_KEY}`;
  const reasonPath = `$.${RESTART_RESUME_REASON_META_KEY}`;
  const marked = database.prepare(
    "SELECT id, json_extract(transport_meta, ?) AS marked_at, json_extract(transport_meta, ?) AS reason FROM sessions WHERE json_type(transport_meta, ?) = 'text' AND workflow_kind IS NULL",
  );
  const clear = database.prepare(
    "UPDATE sessions SET transport_meta = NULLIF(json_remove(transport_meta, ?, ?), '{}') WHERE id = ?",
  );
  const alreadyResuming = database.prepare(
    "SELECT 1 FROM queue_items WHERE session_id = ? AND status IN ('pending', 'running') LIMIT 1",
  );
  type MarkRow = { id: string; marked_at: string; reason: string | null };
  const consume = database.transaction(() => {
    const resumable: MarkRow[] = [];
    const replaying: MarkRow[] = [];
    for (const row of marked.all(jsonPath, reasonPath, jsonPath) as MarkRow[]) {
      clear.run(jsonPath, reasonPath, row.id);
      (alreadyResuming.get(row.id) ? replaying : resumable).push(row);
    }
    return { resumable, replaying };
  });
  const rows = consume.immediate();
  const load = (list: MarkRow[]): RestartResumeCandidate[] => list.flatMap((row) => {
    const session = getSession(row.id);
    return session ? [{ session, reason: resumeReason(row.reason), markedAt: row.marked_at }] : [];
  });
  return { resumable: load(rows.resumable), replaying: load(rows.replaying).map((candidate) => candidate.session) };
}

/** Order the sessions a restart interrupted, newest conversation first, and
 *  spread their wake-ups over the stagger window. The sessions that asked for
 *  the restart go first whatever their activity: they are the ones most likely
 *  to be mid-procedure (a deploy waiting to verify itself), and the cap must
 *  never defer them behind bystanders. */
export function planRestartResumes(input: { candidates: Array<Session | RestartResumeCandidate>; now: number }): RestartResumePlan {
  const ordered = input.candidates.map(asCandidate).sort((x, y) => {
    const requested = Number(y.reason === "requested") - Number(x.reason === "requested");
    if (requested !== 0) return requested;
    const activity = activityMillis(y.session) - activityMillis(x.session);
    return activity !== 0 ? activity : x.session.id.localeCompare(y.session.id);
  }).map((candidate) => candidate.session);
  const resumes = ordered.slice(0, MAX_RESTART_RESUMES).map((session, index) => ({
    sessionId: session.id,
    dueAt: input.now + index * RESTART_RESUME_STAGGER_MS,
  }));
  return { resumes, deferred: ordered.slice(MAX_RESTART_RESUMES).map((session) => session.id) };
}

/** The wake-up itself. Both halves matter: the session must know the break was
 *  the gateway's doing and not the operator's, and it must re-check anything
 *  that was mid-flight rather than assume it ran or blindly run it again. */
export function restartResumeMessage(gatewayVersion: string, reason: RestartResumeReason = "interrupted"): string {
  if (reason === "requested") {
    return (
      `[Gateway] The restart this session requested is complete (v${gatewayVersion}). It replaced this ` +
      `session's engine process, so any background task or monitor you were waiting on for the result was ` +
      `stopped and will not notify you. Check the outcome directly (its log, its output, the service itself) ` +
      `and continue from where you left off. Do not request another restart unless you have confirmed this ` +
      `one did not do what you needed.`
    );
  }
  if (reason === "background") {
    return (
      `[Gateway] Restart complete (v${gatewayVersion}). This session was idle but waiting on background work ` +
      `when the gateway restarted, not the operator. That work was stopped with this session's engine process, ` +
      `so its completion notification will never arrive. Check its outcome directly — anything you detached ` +
      `(setsid, nohup) may still be running — then continue from where you left off, re-running what is still needed.`
    );
  }
  return (
    `[Gateway] Restart complete (v${gatewayVersion}). Your previous turn was interrupted by a gateway ` +
    `restart, not by the operator. Continue from where you left off — but re-verify the outcome of any ` +
    `command that was in flight before assuming it ran or re-running it.`
  );
}

/**
 * Wake one interrupted session through the durable delivery outbox, which
 * retries on its own and collapses a repeat claim onto the same row. Says
 * whether this call is the one that claimed the nudge, and if not, why — the
 * restart record needs the reason, not just the boolean.
 */
export function notifyGatewayRestartResume(
  session: Session,
  gatewayVersion: string,
  mark?: Pick<RestartResumeCandidate, "reason" | "markedAt">,
): RestartNudgeResult {
  if (mark && mark.reason !== "interrupted") return notifyMarkedRestartResume(session, gatewayVersion, mark);
  const terminalOutcome = session.attemptOutcome ?? "interrupted";
  const terminalVersion = Math.max(1, session.attemptTerminalVersion ?? 0);
  const attemptToken = session.attemptToken
    ?? ensureCallbackAttemptToken(session.id, terminalOutcome, terminalVersion);
  if (!attemptToken) {
    logger.warn(`[restart-resume] Session ${session.id} has no callback attempt token; not nudging it to continue`);
    return { claimed: false, reason: "no-attempt-token" };
  }
  const message = restartResumeMessage(gatewayVersion);
  const { delivery, claimed } = claimSessionDelivery({
    targetSessionId: session.id,
    sourceKind: "session",
    sourceId: session.id,
    sourceAttempt: attemptToken,
    sourceOutcome: RESTART_RESUME_SOURCE_OUTCOME,
    sourceVersion: terminalVersion,
    deliveryKind: RESTART_RESUME_DELIVERY_KIND,
    payload: { message, displayMessage: message },
  });
  if (delivery.status === "accepted") return { claimed: false, reason: "already-delivered" };
  deliverClaimedSessionDelivery(delivery.id).catch((error) => {
    logger.warn(`[restart-resume] Failed to nudge session ${session.id}: ${error instanceof Error ? error.message : String(error)}`);
  });
  return claimed ? { claimed: true, deliveryId: delivery.id } : { claimed: false, reason: "already-nudged" };
}

/**
 * The nudge for a session the restart did not catch mid-turn. Its attempt token
 * belongs to a turn that finished normally, so the delivery is keyed on the mark
 * itself instead: one nudge per restart request, or per restart that found it
 * waiting, however many boots try to claim it.
 */
function notifyMarkedRestartResume(
  session: Session,
  gatewayVersion: string,
  mark: Pick<RestartResumeCandidate, "reason" | "markedAt">,
): RestartNudgeResult {
  const message = restartResumeMessage(gatewayVersion, mark.reason);
  const { delivery, claimed } = claimSessionDelivery({
    targetSessionId: session.id,
    sourceKind: "session",
    sourceId: session.id,
    sourceAttempt: `${mark.reason}:${mark.markedAt}`,
    sourceOutcome: RESTART_RESUME_SOURCE_OUTCOME,
    sourceVersion: 1,
    deliveryKind: RESTART_RESUME_DELIVERY_KIND,
    payload: { message, displayMessage: message },
  });
  if (delivery.status === "accepted") return { claimed: false, reason: "already-delivered" };
  if (claimed && mark.reason === "requested") stampRestartRequesterNudged(session.id, new Date().toISOString());
  deliverClaimedSessionDelivery(delivery.id).catch((error) => {
    logger.warn(`[restart-resume] Failed to nudge session ${session.id}: ${error instanceof Error ? error.message : String(error)}`);
  });
  return claimed ? { claimed: true, deliveryId: delivery.id } : { claimed: false, reason: "already-nudged" };
}

/**
 * Boot step: tell every session this restart interrupted to carry on, and write
 * what became of each one to the restart record. Runs after the pending web
 * queue replay, so a session already back on the engine through its own queue
 * item is skipped rather than resumed twice.
 */
export function resumeRestartInterruptedSessions(gateway: RestartRecordGateway): void {
  // A requester re-driven by its own pending queue item is left to it like any other
  // replaying session: it gets the restart notice and its queued input, not the requester
  // message, and the loop guard does not count it — the queued input, not a nudge, is what
  // brings it back.
  const { resumable, replaying } = consumeRestartResumeCandidates();
  for (const session of replaying) {
    recordRestartResume(gateway, session, "queue-replay");
    logger.info(`Interrupted session ${session.id} (${describe(session)}) resumes through its pending queue item, not a restart nudge`);
  }
  if (resumable.length === 0) return;
  if (loadConfig().gateway.resumeInterruptedSessions === false) {
    for (const { session } of resumable) {
      recordRestartResume(gateway, session, "disabled");
      logger.info(`Interrupted session ${session.id} (${describe(session)}) left for the operator: restart resume nudges are off`);
    }
    logger.info(`Restart resume nudges are off — left ${resumable.length} interrupted session(s) for the operator`);
    return;
  }
  const plan = planRestartResumes({ candidates: resumable, now: Date.now() });
  const byId = new Map(resumable.map((candidate) => [candidate.session.id, candidate]));
  for (const resume of plan.resumes) {
    const candidate = byId.get(resume.sessionId)!;
    const { session } = candidate;
    setTimeout(() => {
      const result = notifyGatewayRestartResume(session, gateway.gatewayVersion, candidate);
      if (result.claimed) {
        const why = candidate.reason === "interrupted" ? "" : ` (${candidate.reason})`;
        recordRestartResume(gateway, session, "nudged", `delivery ${result.deliveryId}${why}`);
        logger.info(`Nudged ${candidate.reason} session ${session.id} (${describe(session)}) to continue after restart`);
      } else {
        recordRestartResume(gateway, session, result.reason);
        logger.info(`Did not nudge interrupted session ${session.id} (${describe(session)}) after restart: ${result.reason}`);
      }
    }, Math.max(0, resume.dueAt - Date.now())).unref();
  }
  for (const sessionId of plan.deferred) {
    const { session } = byId.get(sessionId)!;
    recordRestartResume(gateway, session, "deferred", `over the cap of ${MAX_RESTART_RESUMES}`);
    logger.warn(`Interrupted session ${sessionId} (${describe(session)}) left for the operator: over the restart resume cap of ${MAX_RESTART_RESUMES}`);
  }
  const overflow = plan.deferred.length > 0 ? ` (${plan.deferred.length} deferred over the cap of ${MAX_RESTART_RESUMES})` : "";
  logger.info(`Resuming ${plan.resumes.length} interrupted session(s) after restart${overflow}`);
}

const RESTART_REQUESTER_LOOP_GUARD_MINUTES = Math.round(RESTART_REQUESTER_LOOP_GUARD_MS / 60_000);

function resumeReason(value: string | null): RestartResumeReason {
  return value === "requested" || value === "background" ? value : "interrupted";
}

function asCandidate(candidate: Session | RestartResumeCandidate): RestartResumeCandidate {
  return "session" in candidate ? candidate : { session: candidate, reason: "interrupted", markedAt: candidate.lastActivity };
}

function describe(session: Session): string {
  return `${session.engine}${session.employee ? `, ${session.employee}` : ""}`;
}

/** A live request for this restart. A stale acknowledgement (its restart never ran) does not
 *  count, or a running session carrying one would be set idle with no resume mark, and the boot
 *  would then read the acknowledgement as stale and leave its interrupted turn orphaned. */
function hasRestartAcknowledgement(session: Session): boolean {
  const meta = session.transportMeta;
  return Boolean(
    meta && typeof meta === "object" && !Array.isArray(meta)
    && typeof meta[RESTART_ACK_META_KEY] === "string"
    && !isStaleRestartAcknowledgement(meta[RESTART_ACK_META_KEY]),
  );
}

function existingTransportMeta(session: Session): JsonObject {
  const meta = session.transportMeta;
  return meta && typeof meta === "object" && !Array.isArray(meta) ? { ...meta } : {};
}

function activityMillis(session: Session): number {
  const parsed = Date.parse(session.lastActivity);
  return Number.isNaN(parsed) ? 0 : parsed;
}
