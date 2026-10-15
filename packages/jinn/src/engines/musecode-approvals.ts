import { logger } from "../shared/logger.js";
import { uuidv7, type MspClient } from "./musecode-msp.js";
import { allowingChoiceId } from "./musecode-protocol.js";

/**
 * The server's requests of the client: `approval/request` and `userInput/request`.
 *
 * In `allowAll` mode (what a turn starts its session in) approvals are not asked
 * for at all, but one that comes is decided (allow) and a question for the user
 * is declined, since either left alone holds the turn open forever.
 *
 * The reply to such a request is only the protocol's presentation receipt: it
 * changes nothing. The decision is its own command (`approval/decide` with one
 * of the request's `availableChoices`, `userInput/cancel`), sent once the
 * receipt is out.
 */
export function answerMuseServerRequest(client: MspClient, method: string, params: Record<string, unknown>): Record<string, never> {
  if (method === "approval/request") setImmediate(() => void decideApproval(client, params));
  else if (method === "userInput/request") setImmediate(() => void declineUserInput(client, params));
  return {};
}

export async function decideApproval(client: MspClient, params: Record<string, unknown>): Promise<void> {
  const choiceId = allowingChoiceId(params.availableChoices);
  if (!choiceId) {
    logger.warn(`Muse Code asked for approval of ${String(params.toolName ?? "a tool call")} with no allowing choice`);
    return;
  }
  try {
    await client.request("approval/decide", {
      commandId: uuidv7(),
      sessionId: params.sessionId,
      approvalId: params.approvalId,
      choiceId,
      requirementId: params.currentRequirementId,
    });
  } catch (err) {
    logger.warn(`Muse Code approval/decide failed: ${err instanceof Error ? err.message : err}`);
  }
}

export async function declineUserInput(client: MspClient, params: Record<string, unknown>): Promise<void> {
  try {
    await client.request("userInput/cancel", {
      commandId: uuidv7(),
      sessionId: params.sessionId,
      userInputId: params.userInputId,
      reason: "Marid runs this session unattended",
    });
  } catch (err) {
    logger.warn(`Muse Code userInput/cancel failed: ${err instanceof Error ? err.message : err}`);
  }
}
