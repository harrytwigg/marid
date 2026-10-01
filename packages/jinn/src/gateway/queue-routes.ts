// The operator surface over a session's durable turn queue. Split out of
// api.ts, which carries these routes' history and is at its size baseline.
import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import {
  cancelAllPendingQueueItems,
  cancelQueueItem,
  editPendingQueueItem,
  getQueueItem,
  getQueueItems,
  getSession,
  reassignPendingQueuePayloads,
} from "../sessions/registry.js";
import { rotatePendingToFront } from "../sessions/queue-rotation.js";
import { supersedeRunningTurn } from "../sessions/turn/superseded.js";
import { USER_MESSAGE_INTERRUPTION_REASON } from "../sessions/interruption-reasons.js";
import { messageBodyError } from "../shared/message-body.js";
import { isInterruptibleEngine, type InterruptibleEngine, type Session } from "../shared/types.js";
import { readJsonBody } from "./http-helpers.js";
import { badRequest, json, matchRoute, notFound } from "./route-helpers.js";
import type { ApiContext } from "./api.js";

/** The queue is keyed by session key, not session id: a resumed session keeps its rows. */
function queueKey(session: Session): string {
  return session.sessionKey || session.sourceRef || session.id;
}

interface QueueRouteArgs {
  req: HttpRequest;
  res: ServerResponse;
  context: ApiContext;
  session: Session;
  params: Record<string, string>;
}

/**
 * The item a caller may still act on: theirs, operator-visible, and not yet
 * claimed by a turn. Anything else is reported rather than silently ignored.
 */
function resolveEditableItem(res: ServerResponse, params: Record<string, string>, verb: string) {
  const item = getQueueItem(params.itemId);
  if (!item || item.sessionId !== params.id || item.internal) {
    notFound(res);
    return undefined;
  }
  if (item.status !== "pending") {
    json(res, { error: `Only a pending message can be ${verb}` }, 409);
    return undefined;
  }
  return item;
}

function cancelOneItem({ res, context, session, params }: QueueRouteArgs): void {
  if (!cancelQueueItem(params.itemId)) {
    return json(res, { error: "Item not found or already running" }, 409);
  }
  context.emit("queue:updated", { sessionId: params.id, sessionKey: session.sessionKey });
  return json(res, { status: "cancelled", itemId: params.itemId });
}

function listItems({ res, session }: QueueRouteArgs): void {
  return json(res, getQueueItems(queueKey(session)));
}

function clearPendingItems({ res, context, session, params }: QueueRouteArgs): void {
  const sessionKey = queueKey(session);
  // Cancel only operator-visible rows. SessionQueue checks each durable row
  // before execution, so no coarse in-memory cancellation is needed here;
  // setting one would also discard protected internal callback rows.
  const cancelled = cancelAllPendingQueueItems(sessionKey);
  context.emit("queue:updated", { sessionId: params.id, sessionKey, depth: 0 });
  return json(res, { status: "cleared", cancelled });
}

function pause({ res, context, session, params }: QueueRouteArgs): void {
  const sessionKey = queueKey(session);
  context.sessionManager.getQueue().pauseQueue(sessionKey);
  context.emit("queue:updated", { sessionId: params.id, sessionKey, paused: true });
  return json(res, { status: "paused", sessionId: params.id });
}

function resume({ res, context, session, params }: QueueRouteArgs): void {
  const sessionKey = queueKey(session);
  context.sessionManager.getQueue().resumeQueue(sessionKey);
  context.emit("queue:updated", { sessionId: params.id, sessionKey, paused: false });
  return json(res, { status: "resumed", sessionId: params.id });
}

async function editItem({ req, res, context, session, params }: QueueRouteArgs): Promise<void> {
  const parsed = await readJsonBody(req, res);
  if (!parsed.ok) return;
  const body = (parsed.body ?? {}) as Record<string, unknown>;
  const prompt = body.prompt;
  if (typeof prompt !== "string") return badRequest(res, "prompt is required");
  const promptError = messageBodyError(prompt, "prompt");
  if (promptError) return badRequest(res, promptError);
  if (!resolveEditableItem(res, params, "edited")) return;
  const updated = editPendingQueueItem(params.itemId, prompt);
  // The item can leave `pending` between the check and the write; the edit
  // refuses rather than rewriting text an engine has already been handed.
  if (!updated) return json(res, { error: "Only a pending message can be edited" }, 409);
  context.emit("queue:updated", { sessionId: params.id, sessionKey: queueKey(session) });
  return json(res, { status: "updated", item: updated });
}

function isTurnRunning(engine: InterruptibleEngine, sessionId: string): boolean {
  return "isTurnRunning" in engine
    ? (engine as unknown as { isTurnRunning(id: string): boolean }).isTurnRunning(sessionId)
    : engine.isAlive(sessionId);
}

/**
 * Cut the live turn short so the promoted message runs next.
 *
 * Deliberately not `/stop`'s kill: that one also clears the queue, and here the
 * rest of the chain still has to drain behind the message being promoted.
 */
function interruptRunningTurn(context: ApiContext, session: Session): void {
  if (session.status !== "running") return;
  const engine = context.sessionManager.getEngine(session.engine);
  if (!engine || !isInterruptibleEngine(engine) || !isTurnRunning(engine, session.id)) return;
  supersedeRunningTurn(session);
  engine.kill(session.id, USER_MESSAGE_INTERRUPTION_REASON);
  context.emit("session:interrupted", { sessionId: session.id, reason: "send now" });
}

function sendNow({ res, context, session, params }: QueueRouteArgs): void {
  const item = resolveEditableItem(res, params, "sent now");
  if (!item) return;
  const sessionKey = queueKey(session);
  const parked = getQueueItems(sessionKey).filter((row) => row.status === "pending");
  const promoted = rotatePendingToFront(parked, item.id);
  reassignPendingQueuePayloads(promoted.map((payload, index) => ({ id: parked[index].id, payload })));
  interruptRunningTurn(context, session);
  context.emit("queue:updated", { sessionId: params.id, sessionKey });
  return json(res, { status: "sent-now", itemId: params.itemId });
}

/**
 * Most specific first: `/queue/:itemId` also matches `/queue/pause`, so only the
 * method keeps those two apart.
 */
const QUEUE_ROUTES: Array<{ method: string; pattern: string; run: (args: QueueRouteArgs) => void | Promise<void> }> = [
  { method: "POST", pattern: "/api/sessions/:id/queue/:itemId/send-now", run: sendNow },
  { method: "PATCH", pattern: "/api/sessions/:id/queue/:itemId", run: editItem },
  { method: "DELETE", pattern: "/api/sessions/:id/queue/:itemId", run: cancelOneItem },
  { method: "GET", pattern: "/api/sessions/:id/queue", run: listItems },
  { method: "DELETE", pattern: "/api/sessions/:id/queue", run: clearPendingItems },
  { method: "POST", pattern: "/api/sessions/:id/queue/pause", run: pause },
  { method: "POST", pattern: "/api/sessions/:id/queue/resume", run: resume },
];

/** Returns false when the request is not a queue route, so api.ts keeps matching. */
export async function handleSessionQueueRoute(
  method: string,
  pathname: string,
  req: HttpRequest,
  res: ServerResponse,
  context: ApiContext,
): Promise<boolean> {
  for (const route of QUEUE_ROUTES) {
    if (route.method !== method) continue;
    const params = matchRoute(route.pattern, pathname);
    if (!params) continue;
    const session = getSession(params.id);
    if (!session) notFound(res);
    else await route.run({ req, res, context, session, params });
    return true;
  }
  return false;
}
