import type { IncomingMessage, ServerResponse } from "node:http";
import { UNIDENTIFIED_TOOL_CALL_ERROR } from "../mcp/identity.js";
import { reportingParentSessionId } from "../work-items/employee-session-delegation.js";
import { resolveAutoCompactPolicy } from "../shared/auto-compact-config.js";
import { resolveContextWindow } from "../shared/context-window.js";
import { logger } from "../shared/logger.js";
import { getModelRegistry } from "../shared/models.js";
import type { JinnConfig, Session } from "../shared/types.js";
import { isAutoCompacting } from "../sessions/auto-compaction.js";
import { reportedSessionStatus } from "../sessions/background-work.js";
import { compactCommandRefusal } from "../sessions/compact-command.js";
import { listPendingQueueItemIdsForSession, runningQueuePromptsForSession } from "../sessions/queue-item-registry.js";
import { claimSelfCompaction, getEngineSessionRef, getSession, releaseSelfCompaction } from "../sessions/registry.js";
import {
  compactionUnsupported,
  isCompactCommand,
  SELF_COMPACTION_COOLDOWN_MS,
  selfCompactionClaimedAt,
} from "../sessions/self-compaction.js";
import { isTerminalSession } from "../terminals/session.js";
import { enqueueViaMessageRoute } from "./self-compaction-api.js";
import { json, matchRoute, notFound, type ParsedRoute } from "./route-helpers.js";
import { isDescendantOf, type CallerIdentity } from "./session-comm-guards.js";

/**
 * The context meter's two routes.
 *
 *   GET  /api/sessions/:id/context-usage  how full the session's context is, the
 *                                         model's window, the auto-compaction
 *                                         policy and whether a manual compaction
 *                                         would be accepted right now
 *   POST /api/sessions/:id/compact        queue that compaction
 *
 * Both answer "may this session compact now?" with the one function,
 * `compactAvailability`, so the meter's button and the POST cannot disagree. The
 * POST queues the same turn an operator's typed `/compact` does (preflight marks
 * it a compaction; the chat shows "Compacting context…" and, once settled, the
 * confirmation with the new size), and shares the 10-minute `selfCompactionAt`
 * claim with `compact_session`, so a manual and a self-requested compaction
 * cannot stack.
 */

export type RefusalCode =
  | "busy" | "queued" | "compacting" | "cooldown" | "unsupported" | "no-conversation" | "terminal";

export type CompactRefused = { available: false; reason: { code: RefusalCode; message: string }; retryAt?: string };
export type CompactAvailability = { available: true } | CompactRefused;

export interface AvailabilityDeps {
  /** `engines.opencode.mode`. */
  opencodeMode: string | undefined;
  now: number;
  isAutoCompacting: (sessionId: string) => boolean;
  /** The status the API reports for the session (background work counts as running). */
  reportedStatus: (session: Session) => Session["status"];
  /** Whether the turn the session is running now is itself a compaction. */
  runningTurnIsCompaction: (sessionId: string) => boolean;
  pendingQueueCount: (sessionId: string) => number;
}

const COOLDOWN_MESSAGE = "This session was compacted or asked to compact a moment ago; wait before compacting again.";

const refusal = (code: RefusalCode, message: string, retryAt?: number): CompactRefused => ({
  available: false,
  reason: { code, message },
  ...(retryAt !== undefined ? { retryAt: new Date(retryAt).toISOString() } : {}),
});

/** Refusals that are about the session itself, whatever it is doing. */
function structuralRefusal(session: Session, opencodeMode: string | undefined): CompactRefused | undefined {
  if (isTerminalSession(session)) return refusal("terminal", "A terminal session has no model context to compact.");
  const hasConversation = Boolean(getEngineSessionRef(session, session.engine).id);
  const message = compactCommandRefusal(session.engine, opencodeMode, hasConversation);
  if (!message) return undefined;
  return refusal(compactionUnsupported(session.engine, opencodeMode) ? "unsupported" : "no-conversation", message);
}

/** Refusals that are about what the session is doing: compacting, busy, queued. */
function activityRefusal(session: Session, deps: AvailabilityDeps): CompactRefused | undefined {
  const status = deps.reportedStatus(session);
  const turnRunning = status === "running" || status === "waiting";
  if (deps.isAutoCompacting(session.id) || (turnRunning && deps.runningTurnIsCompaction(session.id))) {
    return refusal("compacting", "The session is already compacting its context.");
  }
  if (turnRunning) return refusal("busy", "The session is busy; compact when the turn has finished.");
  const queued = deps.pendingQueueCount(session.id);
  if (queued > 0) {
    return refusal("queued", `${queued} message${queued === 1 ? " is" : "s are"} queued for this session; compact once they have run.`);
  }
  return undefined;
}

/**
 * Whether a manual compaction of `session` would be accepted now, and if not
 * why. Checked in this order, first refusal wins: terminal, unsupported,
 * no-conversation, compacting, busy, queued, cooldown. Reads the cooldown
 * without claiming it; the POST claims it.
 */
export function compactAvailability(session: Session, deps: AvailabilityDeps): CompactAvailability {
  const refused = structuralRefusal(session, deps.opencodeMode) ?? activityRefusal(session, deps);
  if (refused) return refused;
  const claimedAt = selfCompactionClaimedAt(session);
  if (claimedAt !== undefined && claimedAt + SELF_COMPACTION_COOLDOWN_MS > deps.now) {
    return refusal("cooldown", COOLDOWN_MESSAGE, claimedAt + SELF_COMPACTION_COOLDOWN_MS);
  }
  return { available: true };
}

export interface SessionContextApiOptions {
  getConfig: () => JinnConfig;
  /** The gateway's verified view of who is calling. */
  resolveCaller: () => CallerIdentity;
  /** Queue the compaction turn. Defaults to the message route, as `compact_session` does. */
  enqueueTurn?: (sessionId: string, message: string, displayMessage: string) => Promise<void>;
  now?: () => number;
}

/** What the chat shows for the turn: the prompt itself is the bare command. */
export const MANUAL_COMPACT_PROMPT = "/compact";
export const MANUAL_COMPACT_DISPLAY = "🗜️ Compacting context — requested from the context meter";

function availabilityDeps(options: SessionContextApiOptions): AvailabilityDeps {
  return {
    opencodeMode: options.getConfig().engines.opencode?.mode,
    now: (options.now ?? Date.now)(),
    isAutoCompacting,
    reportedStatus: reportedSessionStatus,
    runningTurnIsCompaction: (id) => runningQueuePromptsForSession(id).some(isCompactCommand),
    pendingQueueCount: (id) => listPendingQueueItemIdsForSession(id).length,
  };
}

function contextUsage(session: Session, options: SessionContextApiOptions): Record<string, unknown> {
  const config = options.getConfig();
  const policy = resolveAutoCompactPolicy(config, session.engine);
  const window = resolveContextWindow(session.engine, session.model, getModelRegistry(config));
  return {
    sessionId: session.id,
    engine: session.engine,
    model: window.model,
    modelLabel: window.modelLabel,
    contextTokens: typeof session.lastContextTokens === "number" ? session.lastContextTokens : null,
    contextWindow: window.contextWindow,
    autoCompact: { enabled: policy?.enabled === true, budgetTokens: policy?.maxContextTokens ?? null },
    compact: compactAvailability(session, availabilityDeps(options)),
  };
}

/** A refusal as the POST answers it: 429 for the cooldown, 409 for the rest. */
function refusalResponse(res: ServerResponse, availability: CompactRefused): void {
  const { reason, retryAt } = availability;
  if (reason.code === "cooldown") return json(res, { code: reason.code, error: reason.message, retryAt }, 429);
  json(res, { code: reason.code, error: reason.message }, 409);
}

/** Who may compact a session: the operator, or an agent that spawned it or
 *  delegated to it — the reach of `POST /api/sessions/:id/stop`, because both
 *  act on a session's turns on its behalf. A tool call that lost its identity
 *  fails closed. Answers the refusal itself. */
function callerMayCompact(res: ServerResponse, session: Session, caller: CallerIdentity): boolean {
  if (caller.kind === "unidentified-tool") {
    json(res, { error: UNIDENTIFIED_TOOL_CALL_ERROR }, 403);
    return false;
  }
  if (caller.kind === "session"
    && !isDescendantOf(session.id, caller.callerId, getSession)
    && reportingParentSessionId(session) !== caller.callerId) {
    json(res, {
      error: `session ${session.id} is not a descendant of your session — agents may only compact sessions they spawned (directly or transitively) or delegated to. Compact your own context with compact_session.`,
    }, 403);
    return false;
  }
  return true;
}

async function requestCompact(res: ServerResponse, session: Session, options: SessionContextApiOptions): Promise<void> {
  const availability = compactAvailability(session, availabilityDeps(options));
  if (!availability.available) return refusalResponse(res, availability);

  // The same claim `compact_session` takes: the read above can be stale by the
  // time of the write, and this is what two requests race on.
  const claim = claimSelfCompaction(session.id, (options.now ?? Date.now)(), SELF_COMPACTION_COOLDOWN_MS);
  if (!claim.claimed) {
    return refusalResponse(res, refusal("cooldown", COOLDOWN_MESSAGE, claim.previousAt + SELF_COMPACTION_COOLDOWN_MS));
  }
  try {
    await (options.enqueueTurn ?? enqueueViaMessageRoute)(session.id, MANUAL_COMPACT_PROMPT, MANUAL_COMPACT_DISPLAY);
  } catch (error) {
    releaseSelfCompaction(session.id, claim.at);
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn(`[context-meter] ${session.id}: compaction turn not queued: ${reason}`);
    return json(res, { error: `Nothing was queued: ${reason}` }, 502);
  }
  logger.info(`[context-meter] ${session.id} (${session.engine}) manual compaction queued`);
  json(res, { status: "queued", sessionId: session.id, engine: session.engine }, 202);
}

export async function handleSessionContextApi(
  _req: IncomingMessage,
  res: ServerResponse,
  route: ParsedRoute,
  options: SessionContextApiOptions,
): Promise<boolean> {
  const usageParams = route.method === "GET" ? matchRoute("/api/sessions/:id/context-usage", route.pathname) : null;
  const compactParams = route.method === "POST" ? matchRoute("/api/sessions/:id/compact", route.pathname) : null;
  const id = usageParams?.id ?? compactParams?.id;
  if (id === undefined) return false;

  const session = getSession(id);
  if (!session) {
    notFound(res);
    return true;
  }
  if (usageParams) {
    json(res, contextUsage(session, options));
    return true;
  }
  if (callerMayCompact(res, session, options.resolveCaller())) await requestCompact(res, session, options);
  return true;
}
