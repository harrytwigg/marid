/**
 * The end of a rate-limit wait on a substitute Claude account. The session goes
 * back to its own account at the override's `until`, which can be days before a
 * weekly-limited substitute resets, so a wait on the substitute ends there at
 * the latest and hands the turn back to run on the session's own account.
 */

import type { RateLimitHandlerOpts, RateLimitOutcome } from "./rate-limit-contract.js";
import type { Session } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { maybeRevertEngineOverride, standingOverrideUntil } from "./engine-override.js";
import { accountOverride } from "./session-account.js";
import { updateSessionForAttempt } from "./registry.js";

/** When a wait on this session's substitute account should hand it back, or
 *  undefined when no account override stands or its window has already passed. */
export function handBackAt(session: Session): Date | undefined {
  const until = accountOverride(session) ? standingOverrideUntil(session) : undefined;
  return until && until.getTime() > Date.now() ? until : undefined;
}

/**
 * Take the session out of `waiting` under this attempt, and let the turn-start
 * revert put it back on its own account, thread and sync point. The turn is not
 * retried here — the caller re-runs it from the start, as the revert left it.
 */
export async function handBack(sessionId: string, attemptToken: string, hooks: RateLimitHandlerOpts["hooks"]): Promise<RateLimitOutcome> {
  const running = updateSessionForAttempt(sessionId, attemptToken, {
    status: "running",
    lastActivity: new Date().toISOString(),
    lastError: null,
  }, ["waiting"]);
  if (!running) {
    await hooks.onCancelled?.();
    return { kind: "cancelled" };
  }
  logger.info(`Session ${sessionId} back on its own Claude account after waiting on a substitute's usage limit`);
  return { kind: "handback", session: maybeRevertEngineOverride(running) };
}

/** The earlier of two optional instants. */
export function earlier(a: Date | undefined, b: Date | undefined): Date | undefined {
  if (!a || !b) return a ?? b;
  return b.getTime() < a.getTime() ? b : a;
}
