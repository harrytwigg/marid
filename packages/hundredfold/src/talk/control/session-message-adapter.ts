import type { ApiContext } from "../../gateway/api.js";
import { dispatchWebSessionRun } from "../../gateway/web-session-dispatch.js";
import { claimIncomingTurn } from "../../sessions/incoming-turn.js";
import { getSession } from "../../sessions/registry.js";
import { requireBoundOperatorEvidence } from "./operator-evidence.js";
import type { TalkControlAdapterContext } from "./types.js";

/** Atomically claim the visible message and queue intent before dispatch. The
 * stable provider operation survives a lost HTTP/runtime receipt and a restart. */
export function dispatchTalkSessionMessage(
  context: ApiContext,
  sessionId: string,
  prompt: string,
  call: TalkControlAdapterContext,
): { messageId: string; queueItemId: string; replayed: boolean } {
  requireBoundOperatorEvidence(call, "send-evidence-required", "Sending a message into a session");
  const session = getSession(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);
  const engine = context.sessionManager.getEngine(session.engine);
  if (!engine) throw new Error(`Engine ${session.engine} is unavailable`);
  const sessionKey = session.sessionKey || session.sourceRef || session.id;
  const claim = claimIncomingTurn({
    sessionId: session.id,
    sessionKey,
    prompt,
    isNotification: true,
    queueVisibility: "visible",
    role: "user",
    content: prompt,
    dedupeKey: call.idempotencyKey,
    durableDedupe: true,
    meta: { talk: { sessionId: call.talkSessionId, providerCallId: call.providerCallId } },
  });
  if (!claim.deduplicated) {
    context.emit("queue:updated", { sessionId: session.id, sessionKey });
    dispatchWebSessionRun(session, prompt, engine, context, { queueItemId: claim.queueItemId });
  }
  if (!claim.messageId || !claim.queueItemId) throw new Error("Talk turn claim lost its durable anchors");
  return { messageId: claim.messageId, queueItemId: claim.queueItemId, replayed: claim.deduplicated };
}
