import { getSession } from "../sessions/registry.js";
import { isStoppedByUser } from "../sessions/stopped-marker.js";
import { logger } from "../shared/logger.js";
import type { Heartbeat } from "./types.js";
import { childWatchSettledReason } from "./child-watch.js";
import { deliverHeartbeat } from "./delivery.js";
import { advanceHeartbeat, claimDueHeartbeats, disarmHeartbeat, postponeHeartbeat } from "./store.js";

const DEFAULT_INTERVAL_MS = 15_000;

export interface HeartbeatSchedulerDeps {
  intervalMs?: number;
  /** Test override. */
  now?: () => number;
  /** Test override; defaults to the durable session outbox. */
  deliver?: (heartbeat: Heartbeat, fireCount: number) => void;
  /** Test override; defaults to the session registry. */
  ownerExists?: (sessionId: string) => boolean;
  /** Test override; defaults to the session's durable stop. */
  ownerStopped?: (sessionId: string) => boolean;
}

/**
 * Why a due heartbeat should be disarmed instead of delivered, or null to
 * deliver it. A row that has outlived its own `expiresAt` never fires, and one
 * whose owning session is gone is the backstop that makes an orphan heartbeat
 * impossible even though sessions have no end hook. Stopping a session is
 * deliberately not one of these cases: a stopped session is recoverable, and its
 * heartbeats should come back with it. The gateway's child-watch is disarmed
 * rather than delivered when its session has no open children, so it never sends
 * an idle wake.
 */
function disarmReasonFor(
  heartbeat: Heartbeat,
  now: number,
  ownerExists: (sessionId: string) => boolean,
): string | null {
  if (heartbeat.expiresAt !== null && heartbeat.expiresAt <= now) return "expired";
  if (!ownerExists(heartbeat.ownerSessionId)) return "owner-session-deleted";
  return childWatchSettledReason(heartbeat);
}

function ownerIsStopped(sessionId: string): boolean {
  const owner = getSession(sessionId);
  return !!owner && isStoppedByUser(owner);
}

/**
 * Disarm a due heartbeat that should never fire again, or hold one whose owner
 * is stopped: the tick would only be refused and dead-lettered, so it waits for
 * someone to start the session on purpose. True when it was not to be delivered.
 */
function settledWithoutDelivery(heartbeat: Heartbeat, now: number, deps: HeartbeatSchedulerDeps): boolean {
  const ownerExists = deps.ownerExists ?? ((sessionId: string) => !!getSession(sessionId));
  const ownerStopped = deps.ownerStopped ?? ownerIsStopped;
  const disarmReason = disarmReasonFor(heartbeat, now, ownerExists);
  if (disarmReason) disarmHeartbeat(heartbeat.id, disarmReason, now);
  else if (ownerStopped(heartbeat.ownerSessionId)) postponeHeartbeat(heartbeat.id, now);
  else return false;
  return true;
}

/**
 * One sweep: deliver every heartbeat whose deadline has passed, then reschedule
 * or disarm it. Returns the number delivered. Exported for tests.
 */
export function sweepOnce(deps: HeartbeatSchedulerDeps = {}): number {
  const now = deps.now?.() ?? Date.now();
  const deliver = deps.deliver ?? deliverHeartbeat;
  let delivered = 0;
  for (const heartbeat of claimDueHeartbeats(now)) {
    if (settledWithoutDelivery(heartbeat, now, deps)) continue;
    try {
      deliver(heartbeat, heartbeat.fireCount + 1);
    } catch (error) {
      // Leave the row due so the next sweep retries. The outbox keys each tick
      // by (heartbeat, fire number), so a retry that duplicates a delivery which
      // did land is discarded rather than waking the session twice.
      logger.warn(
        `[heartbeats] Heartbeat ${heartbeat.id} could not be queued: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    advanceHeartbeat(heartbeat.id, now);
    delivered++;
  }
  return delivered;
}

/** Start the periodic sweep. Returns a stop function. */
export function startHeartbeatScheduler(deps: HeartbeatSchedulerDeps = {}): () => void {
  const timer = setInterval(() => {
    try {
      sweepOnce(deps);
    } catch (error) {
      logger.warn(`[heartbeats] sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, deps.intervalMs ?? DEFAULT_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
