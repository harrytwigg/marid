import type { Connector, Session } from "../shared/types.js";
import { logger } from "../shared/logger.js";

/** Sources whose turns have no originating chat channel to relay back into. */
const NON_CONNECTOR_SOURCES = new Set(["web", "talk", "cron"]);

/**
 * Relay a completed turn's assistant text back to the connector channel that
 * originated the session. Inbound connector messages reply through their own
 * surface, but turns started elsewhere (parent callbacks, cron follow-ups,
 * rate-limit resumes) otherwise never reach the channel. No-ops for web/talk/cron
 * sources, empty text, or a missing connector/replyContext; errors are logged and
 * swallowed so delivery failure never breaks completion.
 */
export async function deliverConnectorReply(
  session: Pick<Session, "source" | "connector" | "replyContext"> & { id?: string },
  text: string,
  connectors: Map<string, Connector>,
): Promise<void> {
  if (!text || NON_CONNECTOR_SOURCES.has(session.source)) return;
  if (!session.connector || !session.replyContext) return;
  const connector = connectors.get(session.connector);
  if (!connector) {
    logger.warn(`Connector reply dropped for session ${session.id ?? "?"}: no connector registered as "${session.connector}"`);
    return;
  }
  try {
    const target = connector.reconstructTarget(session.replyContext);
    await connector.replyMessage(target, text);
  } catch (err) {
    logger.warn(
      `Connector reply delivery failed for session ${session.id ?? "?"}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
