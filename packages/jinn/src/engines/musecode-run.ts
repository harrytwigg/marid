import os from "node:os";
import type { EngineResult, EngineRunOpts } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { getPackageVersion } from "../shared/version.js";
import { processStartFailure } from "../shared/process-start.js";
import { MspClient, MspError, uuidv7 } from "./musecode-msp.js";
import type { MspProcess } from "./musecode-process.js";
import { MUSECODE_AUTH_HELP } from "./musecode-protocol.js";
import type { MuseTurn } from "./musecode-turn.js";

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
  return { sessionId: live.sessionId ?? opts.resumeSessionId ?? "", result: "", error, numTurns: 1 };
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
}

export function openedSession(result: Record<string, unknown>, fallbackId?: string): OpenedSession {
  const session = (result.session ?? {}) as Record<string, unknown>;
  const sessionId = typeof session.sessionId === "string" ? session.sessionId : fallbackId;
  if (!sessionId) throw new Error("Muse Code answered session/start without a session id");
  return { sessionId, modelId: typeof session.modelId === "string" ? session.modelId : undefined };
}

export function interruptedResult(opts: EngineRunOpts, reason: string, sessionId?: string): EngineResult {
  return { sessionId: sessionId ?? opts.resumeSessionId ?? "", result: "", error: reason, ...(sessionId ? { numTurns: 1 } : {}) };
}

/** A failed request, in words for the operator. */
export function describeMspFailure(err: unknown): string {
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
