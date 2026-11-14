import { logger } from "../../shared/logger.js";
import type { Connector, HundredfoldConfig, Session, Target } from "../../shared/types.js";
import type { GatewayEmit } from "../../shared/gateway-events.js";
import type { TurnReceipt, TurnSurface } from "./types.js";
import { LEGACY_PORTAL_NAME } from "../../shared/brand.js";

const THINKING_STATUS = "is thinking...";
const RUNNING_REACTION = "eyes";
const WAITING_REACTION = "hourglass_flowing_sand";

export interface ConnectorTurnSurfaceOptions {
  connector: Connector;
  target: Target;
  session: Session;
  config: HundredfoldConfig;
  /**
   * Whether the turn is allowed to decorate the channel. Cron turns run silently
   * so a scheduled job doesn't spray reactions over a human's thread.
   */
  decorate: boolean;
  emit?: GatewayEmit;
}

/** A rejection is logged and handed to `onFailure`, never rethrown: `TurnSurface.reply` is no-throw. */
async function deliver(connector: Connector, target: Target, text: string, onFailure: (message: string) => void): Promise<void> {
  if (!text) return;
  await connector.replyMessage(target, text).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Connector delivery to ${target.channel} failed: ${message}`);
    onFailure(message);
  });
}

/** Carry a turn over a chat connector: reactions, typing status, and replies. */
export function createConnectorTurnSurface(options: ConnectorTurnSurfaceOptions): TurnSurface {
  const { connector, target, decorate } = options;
  const capabilities = connector.getCapabilities();
  const threadTs = target.thread || target.messageTs;
  let deliveryError: string | null = null;

  const setTyping = async (status: string): Promise<void> => {
    if (!decorate || !connector.setTypingStatus) return;
    await connector.setTypingStatus(target.channel, threadTs, status).catch(() => {});
  };
  const react = async (add: readonly string[], remove: readonly string[]): Promise<void> => {
    if (!decorate || !capabilities.reactions) return;
    for (const emoji of remove) await connector.removeReaction(target, emoji).catch(() => {});
    for (const emoji of add) await connector.addReaction(target, emoji).catch(() => {});
  };

  return {
    async started() {
      await react([RUNNING_REACTION], []);
      await setTyping(THINKING_STATUS);
    },
    delta() {
      // Chat connectors post whole messages; there is no live view to stream into.
    },
    // A banner that fails to land must not fail the turn, so it is logged only.
    notice: (text) => deliver(connector, target, text, () => {}),
    reply: (text) => deliver(connector, target, text, (message) => { deliveryError = message; }),
    async waiting(active: boolean) {
      await setTyping(active ? "" : THINKING_STATUS);
      await react(active ? [WAITING_REACTION] : [RUNNING_REACTION], active ? [RUNNING_REACTION] : [WAITING_REACTION]);
    },
    async settled(receipt: TurnReceipt) {
      await setTyping("");
      await react([], [RUNNING_REACTION, WAITING_REACTION]);
      options.emit?.("session:completed", {
        sessionId: receipt.session.id,
        employee: receipt.session.employee || options.config.portal?.portalName || LEGACY_PORTAL_NAME,
        title: receipt.session.title,
        result: receipt.result,
        error: receipt.error ?? deliveryError,
        cost: receipt.cost,
        durationMs: receipt.durationMs,
      });
    },
  };
}
