import { internalGatewayConnection, internalGatewayHeaders } from "./callback-connection.js";
import { loadConfig } from "../shared/config.js";
import { logger } from "../shared/logger.js";
import type { OperatorAlertEvent } from "../shared/types.js";
import { operatorAlertEnabled, resolveOperatorNotificationTarget, type OperatorNotificationTarget } from "../shared/operator-notification-target.js";

/**
 * Send a fixed notification to the operator's channel — `notifications.*`,
 * else the cron alert channel, else a single-user Telegram allowlist (see
 * resolveOperatorNotificationTarget). Used for alerts that must reach a human
 * without depending on an LLM — rate limits, auth outages, and a workflow
 * parked on a decision with no employee session to wake. Fire-and-forget:
 * errors are logged but never rethrown.
 *
 * `event` names the alert's category. When `notifications.events.<event>` is
 * `false` the message is not sent and a muted alert counts as handled
 * (`onResult(true)`): the operator asked not to be told, so a caller's
 * "already announced" marker must stay set rather than re-fire on every poll.
 * Without an `event` the alert is unconditional.
 *
 * `onResult` always runs, with whether the message actually reached the
 * channel. Callers that debounce on "the operator has been told" need the
 * false as much as the true — a one-shot marker burnt on an alert nobody
 * received is worse than no marker at all.
 */
export function notifyOperatorChannel(message: string, onResult?: (sent: boolean) => void, event?: OperatorAlertEvent): void {
  _sendOperatorNotification(message, event)
    .then((sent) => onResult?.(sent))
    .catch((err) => {
      logger.warn(`[operator-notification] Failed to send operator notification: ${err instanceof Error ? err.message : String(err)}`);
      onResult?.(false);
    });
}

async function _sendOperatorNotification(message: string, event?: OperatorAlertEvent): Promise<boolean> {
  let target: OperatorNotificationTarget | undefined;
  try {
    const config = loadConfig();
    if (event && !operatorAlertEnabled(config, event)) {
      logger.debug(`[operator-notification] ${event} alerts are off (notifications.events.${event}) — not sent`);
      return true;
    }
    target = resolveOperatorNotificationTarget(config);
  } catch {
    // Config unreadable: nothing to resolve against.
  }

  const gateway = internalGatewayConnection();

  if (!target) {
    logger.warn("[operator-notification] No operator notification channel resolves (set notifications.connector/channel) — alert dropped: "
      + message.split("\n")[0]);
    return false;
  }

  const response = await fetch(`${gateway.baseUrl}/api/connectors/${target.connector}/send`, {
    method: "POST",
    headers: internalGatewayHeaders(gateway),
    body: JSON.stringify({ channel: target.channel, text: message }),
  });
  if (!response.ok) throw new Error(`connector notification failed (${response.status})`);
  return true;
}

