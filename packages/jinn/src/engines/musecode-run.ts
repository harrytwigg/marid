import os from "node:os";
import type { EngineResult, EngineRunOpts } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { getPackageVersion } from "../shared/version.js";
import { processStartFailure } from "../shared/process-start.js";
import { MspClient, MspError, uuidv7 } from "./musecode-msp.js";
import { MSP_EXIT_GRACE_MS, type MspProcess } from "./musecode-process.js";
import { MUSECODE_AUTH_HELP } from "./musecode-protocol.js";
import type { MuseTurn } from "./musecode-turn.js";
import { CONVERSATION_KEPT } from "./musecode-turn-text.js";

/**
 * What one Muse Code run needs around the engine's own flow: the state `kill`
 * reaches, and how each way a run can end early is reported.
 */

/** A turn gets this long to wind down after an interrupt before its host is signalled. */
export const INTERRUPT_WAIT_MS = 3000;
/** What one turn has so far, for `kill` and `isAlive` to reach. */
export interface LiveTurn {
  /** Why the turn was stopped from outside, once it has been. */
  reason: string | null;
  proc: MspProcess | null;
  turn: MuseTurn | null;
  sessionId: string | null;
  turnId: string | null;
  settled: boolean;
}


/** `turn/interrupt`, then up to three seconds for the turn to say it is over. */
export async function askTurnToStop(proc: MspProcess, turn: MuseTurn, live: LiveTurn): Promise<void> {
  try {
    await proc.client.request(
      "turn/interrupt",
      { commandId: uuidv7(), sessionId: live.sessionId, ...(live.turnId ? { turnId: live.turnId } : {}) },
      { timeoutMs: INTERRUPT_WAIT_MS },
    );
  } catch (err) {
    logger.debug(`Muse Code turn/interrupt failed: ${err instanceof Error ? err.message : err}`);
  }
  await Promise.race([turn.whenCompleted(), delay(INTERRUPT_WAIT_MS)]);
}

/** The host went away with the turn unfinished; whatever it had streamed is narration, not an answer. */
export async function hostLost(proc: MspProcess, live: LiveTurn, opts: EngineRunOpts): Promise<EngineResult> {
  const exit = await proc.waitForExit();
  const error = `Muse Code exited before the turn finished (code ${exit.code ?? "none"}${exit.signal ? `, signal ${exit.signal}` : ""})`
    + (proc.stderrTail ? `: ${proc.stderrTail.slice(-500)}` : "");
  logger.error(error);
  return { sessionId: live.sessionId ?? opts.resumeSessionId ?? "", result: "", error, ...CONVERSATION_KEPT };
}

/**
 * The host exited before the session opened. Said as a process that did not
 * start, which the turn runner never takes for a stale resume id: the
 * conversation, if there was one, is as resumable as it was.
 */
export async function hostNeverStarted(proc: MspProcess, resume: string | undefined): Promise<EngineResult> {
  const exit = await proc.waitForExit();
  const signal = exit.signal ? os.constants.signals[exit.signal] : 0;
  return { sessionId: resume ?? "", result: "", error: processStartFailure("musecode", { exitCode: exit.code, signal }, proc.stderrTail) };
}

export interface OpenedSession {
  sessionId: string;
  modelId: string | undefined;
  /** The host resumed the session but could not read its log's history (a torn or garbled log). */
  projectionUnavailable: boolean;
}

export function openedSession(result: Record<string, unknown>, fallbackId?: string): OpenedSession {
  const session = (result.session ?? {}) as Record<string, unknown>;
  const sessionId = typeof session.sessionId === "string" ? session.sessionId : fallbackId;
  if (!sessionId) throw new Error("Muse Code answered session/start without a session id");
  const history = (result.history ?? {}) as Record<string, unknown>;
  return {
    sessionId,
    modelId: typeof session.modelId === "string" ? session.modelId : undefined,
    projectionUnavailable: history.noneReason === "projectionUnavailable",
  };
}

export function interruptedResult(opts: EngineRunOpts, reason: string, sessionId?: string): EngineResult {
  return { sessionId: sessionId ?? opts.resumeSessionId ?? "", result: "", error: reason, ...(sessionId ? CONVERSATION_KEPT : {}) };
}

/** Said when Muse refuses a session its terminal view holds. Not a lost conversation: it is intact, and closing the terminal frees it. */
export const MUSECODE_SESSION_IN_USE = "The session is open in the terminal view; close it to continue.";

/** A failed request, in words for the operator. */
export function describeMspFailure(err: unknown): string {
  if (err instanceof MspError && err.kind === "sessionInUse") return MUSECODE_SESSION_IN_USE;
  if (err instanceof MspError) return err.kind === "authRequired" ? `${MUSECODE_AUTH_HELP} (${err.message})` : err.message;
  return err instanceof Error ? err.message : String(err);
}

/** Resolves once the turn has ended, or the connection has gone. */
export function waitForEnd(turn: MuseTurn, client: MspClient): Promise<void> {
  return Promise.race([turn.whenCompleted(), new Promise<void>((resolve) => client.onClose(() => resolve()))]);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

export function packageVersion(): string {
  try {
    return getPackageVersion();
  } catch {
    return "0.0.0";
  }
}

/**
 * Whether a failed `session/resume` means the conversation cannot be loaded, now or ever:
 * the host has no such session, or the id is not one it could have minted. Either way
 * the id is stale and the turn is run again in a fresh conversation.
 */
export function isLostSession(err: unknown): boolean {
  if (!(err instanceof MspError)) return false;
  if (err.kind === "sessionNotFound" || (err.kind === "invalidParams" && /sessionId/.test(err.message))) return true;
  return isRefusedResume(err);
}

/**
 * Muse read the session's log and refused to resume it (`resume_refused_class_c`: an empty
 * log, or one whose permission frame it cannot read, whose remedy is to "start a new session").
 * Whatever the cause, it will refuse every later resume the same way, so the conversation
 * is as good as gone.
 */
function isRefusedResume(err: MspError): boolean {
  const reason = err.data?.reason;
  return typeof reason === "string" && reason.startsWith("resume_refused");
}

/**
 * SIGTERM to a host still running, then SIGKILL if it has not gone after the grace.
 * A host stuck before its first answer, or one that ignores SIGTERM, is not left to
 * hold the turn: the run only ends once its host has.
 */
export async function signalHost(proc: MspProcess, live: LiveTurn): Promise<void> {
  if (live.settled || proc.hasExited) return;
  proc.signal("SIGTERM");
  await delay(MSP_EXIT_GRACE_MS);
  if (!live.settled && !proc.hasExited) proc.signal("SIGKILL");
}
