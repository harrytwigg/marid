import { reportingParentSessionId } from "../work-items/employee-session-delegation.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { UNIDENTIFIED_TOOL_CALL_ERROR } from "../mcp/identity.js";
import { readJsonBody } from "./http-helpers.js";
import { json, type ParsedRoute } from "./route-helpers.js";
import type { CallerIdentity } from "./session-comm-guards.js";
import { internalGatewayConnection, internalGatewayHeaders } from "../sessions/callback-connection.js";
import { deliverClaimedSessionDelivery } from "../sessions/callbacks.js";
import {
  claimSelfCompaction,
  claimSessionDelivery,
  getSession,
  recordChildReportedToParent,
  releaseSelfCompaction,
} from "../sessions/registry.js";
import {
  buildCompactCommand,
  buildResumeMessage,
  COMPACTION_TURN_DISPLAY,
  parseCompactionHandoff,
  RESUME_TURN_DISPLAY,
  SELF_COMPACTION_COOLDOWN_MS,
  selfCompactionRefusal,
} from "../sessions/self-compaction.js";
import { listPendingQueueItemIdsForSession } from "../sessions/queue-item-registry.js";
import { isTerminalSession } from "../terminals/session.js";
import { logger } from "../shared/logger.js";
import type { Session } from "../shared/types.js";

/**
 * `POST /api/compactions` — a session asks to compact its own context and be
 * resumed from a handoff (the `compact_session` tool). See
 * `sessions/self-compaction.ts` for the design; this is only the route.
 *
 * Ordering is the whole contract: the compaction turn must reach the session's
 * queue before the resume turn, and both behind the turn that asked. So the
 * compaction turn is queued synchronously — if it cannot be, nothing was
 * scheduled and the caller is told so — and only then is the resume turn put
 * through the durable session outbox, whose retries can only ever land it
 * later, never earlier.
 */
export interface SelfCompactionApiOptions {
  /** The gateway's verified view of who is calling. */
  resolveCaller: () => CallerIdentity;
  /** `engines.opencode.mode`, read live. */
  opencodeMode: () => string | undefined;
  /** Queue a notification-role turn on a session. Defaults to the same
   *  internal message route parent callbacks use. */
  enqueueTurn?: (sessionId: string, message: string, displayMessage: string) => Promise<void>;
  /** Queue the resume turn durably. Returns whether it is already accepted. */
  deliverResume?: (session: Session, claimedAt: number, message: string) => Promise<"accepted" | "retrying">;
  now?: () => number;
}

const send = (res: ServerResponse, status: number, body: unknown): void => json(res, body, status);

async function enqueueViaMessageRoute(sessionId: string, message: string, displayMessage: string): Promise<void> {
  const gateway = internalGatewayConnection();
  const response = await fetch(`${gateway.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/message`, {
    method: "POST",
    headers: internalGatewayHeaders(gateway),
    body: JSON.stringify({ message, role: "notification", displayMessage }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`the session refused the compaction turn (${response.status}${text ? `: ${text.slice(0, 200)}` : ""})`);
  }
}

async function deliverResumeViaOutbox(session: Session, claimedAt: number, message: string): Promise<"accepted" | "retrying"> {
  const { delivery } = claimSessionDelivery({
    targetSessionId: session.id,
    // A session delivering to itself. "session" is the closest existing source
    // kind (the column is CHECK-constrained); deliveryKind keeps it apart from
    // parent callbacks, which are the only kind the completion batcher merges.
    sourceKind: "session",
    sourceId: session.id,
    sourceAttempt: `self-compaction:${claimedAt}`,
    sourceOutcome: "compaction-requested",
    sourceVersion: 1,
    deliveryKind: "self-compaction-resume",
    payload: { message, displayMessage: RESUME_TURN_DISPLAY },
  });
  if (delivery.status === "accepted") return "accepted";
  return (await deliverClaimedSessionDelivery(delivery.id)) === "accepted" ? "accepted" : "retrying";
}

/** The caller's session when it can compact at all; otherwise answers why not. */
function compactableSession(res: ServerResponse, callerId: string, options: SelfCompactionApiOptions): Session | undefined {
  const session = getSession(callerId);
  if (!session) {
    send(res, 404, { error: `unknown session "${callerId}"` });
    return undefined;
  }
  if (isTerminalSession(session)) {
    send(res, 409, { error: "a terminal session has no model context to compact" });
    return undefined;
  }
  const refusal = selfCompactionRefusal(session.engine, options.opencodeMode());
  if (refusal) {
    send(res, 409, { error: refusal });
    return undefined;
  }
  return session;
}

function queuedRefusal(count: number): string {
  return `${count} message${count === 1 ? " is" : "s are"} already queued for this session and would run between this turn `
    + "and the compaction, so your handoff would be out of date by the time you resume. Nothing was scheduled. "
    + "End your turn, handle what is queued, then call compact_session again.";
}

function cooldownRefusal(previousAt: number): { error: string; retryAt: number } {
  const retryAt = previousAt + SELF_COMPACTION_COOLDOWN_MS;
  return {
    error: `this session already requested a compaction at ${new Date(previousAt).toISOString()}; `
      + `the next is allowed from ${new Date(retryAt).toISOString()}. If one is already scheduled, end your turn.`,
    retryAt,
  };
}

/** Queue the compaction turn. False (and answered) when it could not be, with
 *  the claim given back so the session can try again. */
async function queueCompactionTurn(
  res: ServerResponse,
  session: Session,
  claimedAt: number,
  command: string,
  options: SelfCompactionApiOptions,
): Promise<boolean> {
  try {
    await (options.enqueueTurn ?? enqueueViaMessageRoute)(session.id, command, COMPACTION_TURN_DISPLAY);
    return true;
  } catch (error) {
    releaseSelfCompaction(session.id, claimedAt);
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn(`[self-compaction] ${session.id}: compaction turn not queued: ${reason}`);
    send(res, 502, { error: `nothing was scheduled: ${reason}. Carry on without compacting.` });
    return false;
  }
}

async function requestCompaction(
  req: IncomingMessage,
  res: ServerResponse,
  callerId: string,
  options: SelfCompactionApiOptions,
): Promise<void> {
  const session = compactableSession(res, callerId, options);
  if (!session) return;
  const parsed = await readJsonBody(req, res);
  if (!parsed.ok) return;
  const handoff = parseCompactionHandoff(parsed.body);
  if (!handoff.ok) return send(res, 400, { error: handoff.error });

  const claim = claimSelfCompaction(session.id, (options.now ?? Date.now)(), SELF_COMPACTION_COOLDOWN_MS);
  if (!claim.claimed) return send(res, 429, cooldownRefusal(claim.previousAt));
  // Anything already queued would run as a full turn AFTER the asking turn and
  // BEFORE the compaction — work the handoff, written earlier, knows nothing
  // about. Refuse rather than let a stale handoff steer the resume: handling
  // those messages first costs one turn, and a message arriving after this
  // check queues behind the resume, where it belongs.
  const queued = listPendingQueueItemIdsForSession(session.id).length;
  if (queued > 0) {
    releaseSelfCompaction(session.id, claim.at);
    return send(res, 409, { error: queuedRefusal(queued) });
  }
  if (!await queueCompactionTurn(res, session, claim.at, buildCompactCommand(handoff.handoff), options)) return;
  suppressStopgapCallback(session);
  await scheduleResume(res, session, claim.at, buildResumeMessage(handoff.handoff), options);
}

/**
 * The turn that asked is ending on a stopgap ("compacting now"), not a result.
 * A parent waiting on this child must not take it for the final report, so that
 * one callback is suppressed exactly as for a child that already reported up
 * with send_to_session: per attempt, consumed by the settle it matches, and
 * self-expiring with the attempt.
 */
function suppressStopgapCallback(session: Session): void {
  if (reportingParentSessionId(session) && session.attemptToken && session.status === "running") {
    recordChildReportedToParent(session.id, session.attemptToken);
  }
}

async function scheduleResume(
  res: ServerResponse,
  session: Session,
  claimedAt: number,
  message: string,
  options: SelfCompactionApiOptions,
): Promise<void> {
  let resume: "accepted" | "retrying";
  try {
    resume = await (options.deliverResume ?? deliverResumeViaOutbox)(session, claimedAt, message);
  } catch (error) {
    // The outbox row was not even written. The compaction is queued and will
    // run; without the resume the session would stop after it. Say so plainly
    // rather than pretend: the agent can still put the handoff in its reply.
    const reason = error instanceof Error ? error.message : String(error);
    logger.error(`[self-compaction] ${session.id}: compaction queued but resume not recorded: ${reason}`);
    return send(res, 500, {
      error: `the compaction is queued but the resume turn could not be recorded (${reason}). `
        + "End your turn with the handoff written out in your reply, so it is in the transcript the compaction summarizes.",
    });
  }
  logger.info(`[self-compaction] ${session.id} (${session.engine}) scheduled compaction + resume (resume ${resume})`);
  send(res, 202, { status: "scheduled", sessionId: session.id, engine: session.engine, resume });
}

export async function handleSelfCompactionApi(
  req: IncomingMessage,
  res: ServerResponse,
  route: ParsedRoute,
  options: SelfCompactionApiOptions,
): Promise<boolean> {
  if (route.method !== "POST" || route.pathname !== "/api/compactions") return false;
  // Only a session can compact, and only itself: the target is never an
  // argument. The operator has no context to compact — it types /compact.
  const identity = options.resolveCaller();
  if (identity.kind !== "session") {
    send(res, 403, { error: UNIDENTIFIED_TOOL_CALL_ERROR });
    return true;
  }
  await requestCompaction(req, res, identity.callerId, options);
  return true;
}
