import { renewWorkItemClaimForSession } from "../../work-items/claims.js";
import { getSession, updateSessionForAttempt } from "../registry.js";

/** Wall-clock cadence the status reconciler's staleness threshold is sized against. */
const HEARTBEAT_INTERVAL_MS = 5_000;
/** In-stream floor, so a chatty turn doesn't write a row per token. */
const STREAM_BEAT_MIN_GAP_MS = 2_000;

export interface TurnHeartbeat {
  /** Throttled beat driven by the engine stream. Safe to call per delta. */
  beat(): void;
  stop(): void;
}

/**
 * Keep `lastActivity` fresh while a turn is in flight, so the status reconciler
 * can tell a live turn from a gateway that died mid-turn. Self-disarms when the
 * session is deleted: `engine.run` may not resolve for minutes, and we must not
 * keep writing `running` rows for a session the user already removed.
 *
 * The same beat renews the lease on the Todo this session is working, so the
 * claim an agent holds stays alive on the evidence that it is still working
 * rather than on the agent remembering to say so.
 */
export function armTurnHeartbeat(sessionId: string, attemptToken: string): TurnHeartbeat {
  let lastBeatAt = 0;

  const write = () => {
    updateSessionForAttempt(sessionId, attemptToken, {
      status: "running",
      lastActivity: new Date().toISOString(),
    });
    renewWorkItemClaimForSession(sessionId);
  };

  let timer: ReturnType<typeof setInterval> | undefined = setInterval(() => {
    if (!getSession(sessionId)) {
      stop();
      return;
    }
    write();
  }, HEARTBEAT_INTERVAL_MS);

  function stop(): void {
    if (!timer) return;
    clearInterval(timer);
    timer = undefined;
  }

  return {
    beat() {
      const now = Date.now();
      if (now - lastBeatAt < STREAM_BEAT_MIN_GAP_MS) return;
      lastBeatAt = now;
      write();
    },
    stop,
  };
}
