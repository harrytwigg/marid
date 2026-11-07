// `POST /api/sessions/:id/stop`, made durable: a stop cancels the messages
// parked for the session as well as the turn, and the session then refuses
// agent-sent messages instead of waking on them.
import type { ServerResponse } from "node:http";
import type { Session } from "../shared/types.js";
import { USER_STOP_INTERRUPTION_REASON } from "../sessions/interruption-reasons.js";
import { withdrawPendingQueueItemsForStop } from "../sessions/queue-stop.js";
import { interruptSessionTurn, type ApiContext } from "./api.js";

export const STOPPED_SESSION_NOT_DELIVERED =
  "not delivered: this session was stopped and is not running. Its owner or the operator must start it again " +
  "deliberately; a message sent to a stopped session is dropped, never held for later.";

/** Stopped on purpose, and not restarted since: a restart or a new operator message clears the marker. */
export function isStoppedByUser(session: Session): boolean {
  return session.status === "interrupted" && session.lastError === USER_STOP_INTERRUPTION_REASON;
}

/** Refuse a message that would silently restart a stopped session. True when it refused. */
export function refuseMessageToStoppedSession(res: ServerResponse, session: Session): boolean {
  if (!isStoppedByUser(session)) return false;
  res.writeHead(409, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "not_delivered", sessionId: session.id, error: STOPPED_SESSION_NOT_DELIVERED }));
  return true;
}

export interface SessionStopResult {
  /** False when nothing was running: the session had already finished or been stopped. */
  wasRunning: boolean;
  /** Parked messages dropped by this stop. */
  cancelled: number;
}

/** Stop a session. Idempotent: a session that is not running keeps its status. */
export function stopSession(context: ApiContext, session: Session): SessionStopResult {
  const sessionKey = session.sessionKey || session.sourceRef || session.id;
  // Rows first: the turn's slot settles as soon as the kill lands, and the next
  // slot must find nothing `pending` left to claim.
  const withdrawn = withdrawPendingQueueItemsForStop(session.id);
  const wasRunning = session.status === "running" || session.status === "waiting";
  if (wasRunning) interruptSessionTurn(context, session, USER_STOP_INTERRUPTION_REASON, USER_STOP_INTERRUPTION_REASON);
  if (withdrawn.length > 0) {
    const messageIds = withdrawn.flatMap((item) => (item.messageId ? [item.messageId] : []));
    context.emit("queue:updated", {
      sessionId: session.id,
      sessionKey,
      depth: 0,
      ...(messageIds.length > 0 ? { withdrawnMessageIds: messageIds } : {}),
    });
  }
  return { wasRunning, cancelled: withdrawn.length };
}
