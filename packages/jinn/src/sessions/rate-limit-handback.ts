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
import { updateSessionForAttempt, type UpdateSessionFields } from "./registry.js";

/** When this session, limited on a substitute account, goes back to its own:
 *  the override's `until`, which may already have passed (a turn that started
 *  inside the window and ran past it), or undefined when no account override stands. */
export function handBackAt(session: Session): Date | undefined {
  return accountOverride(session) ? standingOverrideUntil(session) : undefined;
}

/**
 * Hand the turn back under this attempt: leave `waiting` (or `running`, when the
 * window had already closed before any wait began) for `running`, and let the
 * turn-start revert put the session back on its own account, thread and sync
 * point. The turn is not retried here — the caller re-runs it from the start,
 * as the revert left it.
 */
export async function handBack(
  sessionId: string,
  attemptToken: string,
  hooks: RateLimitHandlerOpts["hooks"],
  from: { waited: boolean; fields?: UpdateSessionFields },
): Promise<RateLimitOutcome> {
  const running = updateSessionForAttempt(sessionId, attemptToken, {
    ...from.fields,
    status: "running",
    lastActivity: new Date().toISOString(),
    lastError: null,
  }, [from.waited ? "waiting" : "running"]);
  if (!running) {
    await hooks.onCancelled?.();
    return { kind: "cancelled" };
  }
  logger.info(`Session ${sessionId} back on its own Claude account after ${from.waited ? "waiting on" : "hitting"} a substitute's usage limit`);
  return { kind: "handback", session: maybeRevertEngineOverride(running), waited: from.waited };
}

/** The earlier of two optional instants. */
export function earlier(a: Date | undefined, b: Date | undefined): Date | undefined {
  if (!a || !b) return a ?? b;
  return b.getTime() < a.getTime() ? b : a;
}
