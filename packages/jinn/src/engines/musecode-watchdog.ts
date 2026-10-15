import type { EngineResult } from "../shared/types.js";
import { lostConversationFailure } from "../shared/process-start.js";
import { CONVERSATION_KEPT } from "./musecode-turn-text.js";
import type { MuseTurn } from "./musecode-turn.js";
import type { OpenedSession } from "./musecode-run.js";

/**
 * A turn the host accepted and then never spoke of.
 *
 * Muse resumes a session whose log is torn or garbled (a killed host can leave
 * exactly that tail) with `history.noneReason: "projectionUnavailable"`, accepts
 * `turn/start`, and then sends nothing for ever: no `turn/started`, no error.
 * Without a bound the turn sits running until it is interrupted or times out.
 */

/** How long an accepted turn may go without the host sending anything about it. */
export const FIRST_EVENT_TIMEOUT_MS = 120_000;

export const MUSECODE_NEVER_STARTED = "Muse Code accepted the turn but never started it.";

export interface SilenceWatch {
  /** Resolves when the host has been silent for the whole bound; never if it speaks first or the watch is cancelled. */
  silent: Promise<void>;
  cancel(): void;
}

/** Start the clock on an accepted turn. Cancel it when the turn has ended. */
export function watchForSilence(turn: MuseTurn, timeoutMs: number): SilenceWatch {
  let poll: NodeJS.Timeout | undefined;
  const cancel = (): void => {
    if (poll) clearInterval(poll);
    poll = undefined;
  };
  const silent = new Promise<void>((resolve) => {
    const deadline = Date.now() + timeoutMs;
    poll = setInterval(() => {
      if (turn.hasHeardFromHost || turn.isCompleted) return cancel();
      if (Date.now() < deadline) return;
      cancel();
      resolve();
    }, Math.max(10, Math.min(1000, Math.floor(timeoutMs / 4))));
    poll.unref?.();
  });
  return { silent, cancel };
}

/**
 * What a silent turn becomes. If the session's history was unreadable at resume,
 * the conversation cannot be continued and the runner starts afresh, handing the
 * new one the session so far. Otherwise it is a failure on a conversation that is
 * still there.
 */
export function silentTurnResult(session: OpenedSession): EngineResult {
  if (session.projectionUnavailable) {
    return { sessionId: session.sessionId, result: "", error: lostConversationFailure("musecode", session.sessionId) };
  }
  return { sessionId: session.sessionId, result: "", error: MUSECODE_NEVER_STARTED, ...CONVERSATION_KEPT };
}
