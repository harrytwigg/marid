import fs from "node:fs";
import path from "node:path";
import { RESTART_RECORD_FILE } from "../shared/paths.js";
import { logger } from "../shared/logger.js";
import type { Session } from "../shared/types.js";

/**
 * The durable, human-readable record of what a restart did to live work.
 * There is no reader in the code on purpose: `grep <session id>` and `jq` on
 * the file are the query language (template/docs/architecture.md).
 *
 * The registry cannot answer "which sessions was the gateway mid-turn on when
 * it went down?" after the fact: the `restartInterruptedAt` mark that drives
 * the resume nudge is consumed on the first boot that sees it, and a session
 * that never comes back reads exactly like one that was idle all along. So the
 * old process writes one `interrupted` line per session it cuts short, the new
 * process writes one `resume` line per session saying what it did about it,
 * and both stay on disk after the DB rows have moved on.
 *
 * One JSON object per line, appended, never rewritten: `grep <session id>` on
 * the file is the whole query language, and a crash mid-write costs at most the
 * last line.
 */
export const RESTART_RECORD_MAX_BYTES = 1024 * 1024;

export interface RestartRecordGateway {
  /** The gateway process writing the line — the old one for `interrupted`, the new one for `resume`. */
  bootId: string;
  gatewayVersion: string;
}

/** How the session came to be interrupted. `shutdown` is the gateway marking it on the way
 *  out; `stale-on-boot` is the next boot finding it still `running`, so the old process died
 *  without a clean shutdown. */
export type RestartInterruptionCause = "shutdown" | "stale-on-boot";

/** Who is expected to bring the session back. */
export type RestartResumeOwner =
  /** `resumeRestartInterruptedSessions` will nudge it after boot. */
  | "restart-resume"
  /** It asked for the restart itself: the next boot posts the restart notice in it and stamps it
   *  for a `requested` nudge, unless a requester guard holds the nudge back. */
  | "restart-notice";

export type RestartResumeOutcome =
  /** The nudge was claimed and handed to the delivery outbox. */
  | "nudged"
  /** A nudge for this attempt was already claimed (a second boot, or a duplicate plan). */
  | "already-nudged"
  /** The nudge was already accepted by the session before this boot got to it. */
  | "already-delivered"
  /** No attempt token could be minted, so no nudge was sent; the session is left interrupted. */
  | "no-attempt-token"
  /** A pending queue item re-drives the session, so `resumePendingWebQueueItems` resumes it instead. */
  | "queue-replay"
  /** Over `MAX_RESTART_RESUMES`; left interrupted for the operator. */
  | "deferred"
  /** `gateway.resumeInterruptedSessions` is off; left interrupted for the operator. */
  | "disabled"
  /** A restart requester that asked again too soon after its last requester nudge: notice only. */
  | "loop-guard"
  /** A restart acknowledgement older than this restart (a request whose restart never ran): notice only. */
  | "stale"
  /** One of the board walk's own turns: the next tick replaces it, so it is not resumed. */
  | "board-walk-turn";

interface RestartRecordSession {
  sessionId: string;
  employee: string | null;
  engine: string;
  workItemId: string | null;
  title: string | null;
}

export interface RestartInterruptedEntry extends RestartRecordGateway, RestartRecordSession {
  event: "interrupted";
  at: string;
  cause: RestartInterruptionCause;
  /** The session's status at the moment it was recorded. */
  status: Session["status"];
  resume: RestartResumeOwner;
  /** Free text for the operator: what an idle session was waiting on when it was recorded. */
  detail?: string;
}

export interface RestartResumeEntry extends RestartRecordGateway, RestartRecordSession {
  event: "resume";
  at: string;
  outcome: RestartResumeOutcome;
  /** Free text for the operator: the delivery id, the cap that deferred it, the reason no token existed. */
  detail?: string;
}

export type RestartRecordEntry = RestartInterruptedEntry | RestartResumeEntry;

export function recordRestartInterruption(
  gateway: RestartRecordGateway,
  session: Session,
  cause: RestartInterruptionCause,
  resume: RestartResumeOwner,
  detail?: string,
): void {
  appendRestartRecord({
    event: "interrupted",
    at: new Date().toISOString(),
    ...gateway,
    ...sessionFields(session),
    cause,
    status: session.status,
    resume,
    ...(detail ? { detail } : {}),
  });
}

export function recordRestartResume(
  gateway: RestartRecordGateway,
  session: Session,
  outcome: RestartResumeOutcome,
  detail?: string,
): void {
  appendRestartRecord({
    event: "resume",
    at: new Date().toISOString(),
    ...gateway,
    ...sessionFields(session),
    outcome,
    ...(detail ? { detail } : {}),
  });
}

function sessionFields(session: Session): RestartRecordSession {
  return {
    sessionId: session.id,
    employee: session.employee ?? null,
    engine: session.engine,
    workItemId: session.workItemId ?? null,
    title: session.title ?? null,
  };
}

/** Best-effort: the record must never take the shutdown or the boot down with it. */
function appendRestartRecord(entry: RestartRecordEntry): void {
  try {
    fs.mkdirSync(path.dirname(RESTART_RECORD_FILE), { recursive: true });
    rotateIfOversized();
    fs.appendFileSync(RESTART_RECORD_FILE, `${JSON.stringify(entry)}\n`);
  } catch (error) {
    logger.warn(`[restart-record] Could not append to ${RESTART_RECORD_FILE}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** One previous generation is kept. A restart writes a handful of lines, so the live file takes
 *  years to reach the cap; the rotation exists so it cannot grow without bound, not for space. */
function rotateIfOversized(): void {
  let size: number;
  try {
    size = fs.statSync(RESTART_RECORD_FILE).size;
  } catch {
    return;
  }
  if (size < RESTART_RECORD_MAX_BYTES) return;
  fs.renameSync(RESTART_RECORD_FILE, rotatedPath());
}

function rotatedPath(): string {
  return `${RESTART_RECORD_FILE}.1`;
}
