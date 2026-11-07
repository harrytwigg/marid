// `POST /api/sessions/:id/stop`, made durable: a stop cancels the messages
// parked for the session as well as the turn, and a session stopped on purpose
// then takes no message from anyone but the operator or whoever may stop it.
import type { ServerResponse } from "node:http";
import type { JsonObject, Session } from "../shared/types.js";
import { USER_STOP_INTERRUPTION_REASON } from "../sessions/interruption-reasons.js";
import type { QueueItem } from "../sessions/queue-item-registry.js";
import { withdrawPendingQueueItemsForStop } from "../sessions/queue-stop.js";
import { hasStoppedMark, markSessionStopped } from "../sessions/stopped-marker.js";
import { listReleasableParentCompletionQueuesForSource, RESTART_RESUME_META_KEY, RESTART_RESUME_REASON_META_KEY, updateSession } from "../sessions/registry.js";
import { interruptSessionTurn } from "./session-interrupt.js";
import type { ApiContext } from "./api.js";

export { isStoppedByUser } from "../sessions/stopped-marker.js";

export const STOPPED_SESSION_NOT_DELIVERED =
  "not delivered: this session was stopped and is not running. Its owner or the operator must start it again " +
  "deliberately; a message sent to a stopped session is dropped, never held for later.";

/** Refuse a message that would silently restart a stopped session. True when it refused. */
export function refuseStoppedSession(res: ServerResponse, session: Session): boolean {
  res.writeHead(409, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "not_delivered", sessionId: session.id, error: STOPPED_SESSION_NOT_DELIVERED }));
  return true;
}

export interface SessionStopResult {
  /** A turn was running (or waiting on a limit) and was cut short. */
  wasRunning: boolean;
  /** False when it was already stopped, nothing ran and nothing was parked: the stop changed nothing. */
  changed: boolean;
  /** Parked messages dropped by this stop, delivery-owned ones included. */
  cancelled: number;
}

/** A restart's resume mark would nudge the session at the next boot, against the stop. */
function withoutRestartResumeMark(session: Session): JsonObject | undefined {
  const meta: JsonObject = { ...(session.transportMeta ?? {}) };
  if (!(RESTART_RESUME_META_KEY in meta) && !(RESTART_RESUME_REASON_META_KEY in meta)) return undefined;
  delete meta[RESTART_RESUME_META_KEY];
  delete meta[RESTART_RESUME_REASON_META_KEY];
  return meta;
}

/** Tell every view the parked messages are gone, bubbles included. */
function announceWithdrawn(context: ApiContext, session: Session, withdrawn: QueueItem[]): void {
  if (withdrawn.length === 0) return;
  const messageIds = withdrawn.flatMap((item) => (item.messageId ? [item.messageId] : []));
  context.emit("queue:updated", {
    sessionId: session.id,
    sessionKey: session.sessionKey || session.sourceRef || session.id,
    depth: 0,
    ...(messageIds.length > 0 ? { withdrawnMessageIds: messageIds } : {}),
  });
}

/** Let a parent's completion batch held behind this session's queue go on its way. */
function releaseHeldParentCompletions(context: ApiContext, session: Session): void {
  for (const held of listReleasableParentCompletionQueuesForSource(session.id)) {
    context.sessionManager.getQueue().releaseCallbackDrain(held.sessionKey, held.queueItemId);
  }
}

/**
 * Stop a session. `effectiveStatus` is the status readers see: a turn that
 * ended with background work still going is `running` there, though stored `idle`.
 *
 * Whatever its status, the session is left stopped: a running turn is cut short,
 * everything parked is dropped, and the stop mark makes every later wake but a
 * deliberate start get `not_delivered`. A session stopped while idle keeps its
 * status (nothing ran to interrupt). Stopping a stopped session changes nothing.
 */
export function stopSession(context: ApiContext, session: Session, effectiveStatus: Session["status"]): SessionStopResult {
  // Rows first: the turn's slot settles as soon as the kill lands, and the next
  // slot must find nothing `pending` left to claim.
  const { withdrawn, cancelledDeliveries } = withdrawPendingQueueItemsForStop(session.id);
  const wasRunning = effectiveStatus === "running" || effectiveStatus === "waiting";
  const alreadyStopped = hasStoppedMark(session.id);
  if (wasRunning) interruptSessionTurn(context, session, USER_STOP_INTERRUPTION_REASON, USER_STOP_INTERRUPTION_REASON);
  markSessionStopped(session.id);
  const transportMeta = !wasRunning && session.status === "interrupted" ? withoutRestartResumeMark(session) : undefined;
  if (transportMeta) updateSession(session.id, { transportMeta });
  announceWithdrawn(context, session, withdrawn);
  releaseHeldParentCompletions(context, session);
  const cancelled = withdrawn.length + cancelledDeliveries;
  return { wasRunning, changed: wasRunning || !alreadyStopped || cancelled > 0 || transportMeta !== undefined, cancelled };
}
