import { claimSessionDelivery } from "../sessions/registry.js";
import { deliverClaimedSessionDelivery } from "../sessions/callbacks.js";
import { clipSessionMessage } from "../gateway/session-comm-guards.js";
import { logger } from "../shared/logger.js";
import type { Heartbeat } from "./types.js";

/**
 * Push one heartbeat tick into its owning session through the durable session
 * outbox — the same path parent callbacks use, so heartbeats inherit its retry,
 * dead-lettering and once-only semantics rather than adding a second way to put
 * text into a session.
 *
 * `sourceId` + `sourceAttempt` key the outbox's composite identity index on
 * (heartbeat, fire number), so a tick re-attempted after a failed delivery is a
 * no-op instead of a duplicate wake.
 *
 * The engine-facing `message` is the stored text with nothing composed around
 * it: a heartbeat says what its session told it to say. Only the human-facing
 * banner is clipped, exactly as parent callbacks do.
 */
export function deliverHeartbeat(heartbeat: Heartbeat, fireCount: number): void {
  const { delivery } = claimSessionDelivery({
    targetSessionId: heartbeat.ownerSessionId,
    sourceKind: "heartbeat",
    sourceId: heartbeat.id,
    sourceAttempt: `fire-${fireCount}`,
    sourceOutcome: "fired",
    sourceVersion: 1,
    deliveryKind: "heartbeat",
    payload: {
      message: heartbeat.message,
      displayMessage: `⏰ ${clipSessionMessage(heartbeat.message)}`,
    },
  });
  if (delivery.status === "accepted") return;
  deliverClaimedSessionDelivery(delivery.id).catch((error) => {
    logger.warn(
      `[heartbeats] Failed to deliver heartbeat ${heartbeat.id} to session ${heartbeat.ownerSessionId}: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
  });
}
