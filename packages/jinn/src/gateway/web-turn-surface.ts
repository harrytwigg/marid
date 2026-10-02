import type { Connector, JinnConfig, StreamDelta } from "../shared/types.js";
import type { GatewayEmit } from "../shared/gateway-events.js";
import { logger } from "../shared/logger.js";
import { getSession, insertMessage } from "../sessions/registry.js";
import type { TurnReceipt, TurnSurface } from "../sessions/turn/types.js";
import { deliverConnectorReply } from "./connector-reply.js";

export interface WebTurnSurfaceOptions {
  sessionId: string;
  emit: GatewayEmit;
  connectors: Map<string, Connector>;
  getConfig: () => JinnConfig;
}

/**
 * Keep a notice in the transcript and show it live, not only on the next
 * reload: a notice can be all a turn shows (a `/compact` confirmation, or the
 * reason one was declined).
 */
function recordNotice(sessionId: string, emit: GatewayEmit, text: string): void {
  insertMessage(sessionId, "notification", text);
  try {
    emit("session:notification", { sessionId, message: text });
  } catch (err) {
    logger.warn(`Failed to emit notice for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Carry a turn over the dashboard: stream deltas to the live view, keep
 * lifecycle prose in the transcript, and relay the answer onward to a chat
 * channel when the session originally came from one.
 */
export function createWebTurnSurface(options: WebTurnSurfaceOptions): TurnSurface {
  const { sessionId, emit } = options;

  return {
    async started() {
      // `session:started` is emitted at dispatch, before the queue slot opens,
      // so the dashboard shows a spinner while the turn is still queued.
    },
    delta(delta: StreamDelta) {
      try {
        emit("session:delta", {
          sessionId,
          type: delta.type,
          content: delta.content,
          toolName: delta.toolName,
          toolId: delta.toolId,
          activityReceiptId: delta.activityReceiptId,
          input: delta.input,
          ...(delta.sidechain ? { sidechain: true } : {}),
          block: delta.block,
        });
      } catch (err) {
        logger.warn(`Failed to emit stream delta for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    async notice(text: string) {
      recordNotice(sessionId, emit, text);
    },
    async reply(text: string) {
      const session = getSession(sessionId);
      if (!session) return;
      await deliverConnectorReply(session, text, options.connectors);
    },
    async waiting() {
      // The dashboard reads the waiting state off the session row directly.
    },
    async settled(receipt: TurnReceipt) {
      emit("session:completed", {
        sessionId,
        employee: receipt.session.employee || options.getConfig().portal?.portalName || "Jinn",
        title: receipt.session.title,
        result: receipt.result,
        error: receipt.error,
        cost: receipt.cost,
        durationMs: receipt.durationMs,
      });
    },
  };
}
