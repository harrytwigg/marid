import { STRUCTURED_MESSAGE_BODY_MAX_CHARS, type Session } from "../shared/types.js";
import { CALLER_SESSION_CAPABILITY_HEADER, CALLER_SESSION_HEADER, TOOL_CALL_HEADER } from "../mcp/identity.js";

/**
 * GRS-017a — substrate guards for agent-initiated (lateral) session messaging.
 *
 * The design ruling (GRS-017 §2.4): runaway-loop protection between sessions is
 * enforced HERE, gateway-side, not by prompt doctrine — so it holds for MCP and
 * curl alike. Two guards, both deterministic, both in-memory.
 *
 * PERSISTENCE DECISION (GRS-017c, argued): guard state deliberately does NOT
 * survive a gateway restart. A storm is driven by live engine turns, and a
 * restart kills exactly those actors — the restart extinguishes the storm the
 * state was bounding. The worst case after a restart is one fresh hop budget,
 * and a crash-loop that repeatedly resets the
 * guards is a gateway-health incident, not a comm-storm — each restart cycle
 * costs seconds, which throttles harder than the window does. Durable guard
 * state would need a store + cleanup + migration: a new primitive the marginal
 * bound does not earn (catalog rule: primitive first, wrapper later).
 *
 * CONCURRENCY INVARIANT: every guard mutation (recordDelivery, pruning) is
 * SYNCHRONOUS — no await between read and write — so Node's event loop
 * serializes it. Do not introduce an await inside these methods.
 *
 * MEMORY BOUND: real caller ids are validated against live sessions route-side
 * (spoofed ids are refused before any guard call), so the hop map is bounded by
 * the session count; lazy pruning (every {@link PRUNE_EVERY_OPS} guard ops)
 * additionally sweeps expired hop tags so idle sessions don't linger.
 *
 * The guards:
 *
 *   1. no-self-message (checked in prepareLateralSend, before any state changes);
 *   2. a relay hop budget: each delivered lateral message tags its target with an
 *      inbound hop count; the target's next lateral send is hop n+1; beyond
 *      LATERAL_MAX_HOPS the route refuses ("escalate instead of forwarding").
 *      Hop state expires (TTL) and is cleared when a genuine user/operator
 *      message reaches the session — an operator instruction resets the chain.
 *   3. a parent/child pair budget: messages between a session and its reporting
 *      parent (either direction, e.g. a spawned reviewer replying to the
 *      session that asked for the review) are not relay hops. They do not use
 *      the lateral budget and do not tag the receiver, so a session spawned by
 *      another starts a fresh chain at hop 1. They are counted per pair instead,
 *      against a larger cap (PAIR_CAP_FACTOR × the hop cap), so a long review
 *      still completes but a parent and child that keep acknowledging each
 *      other (or relay through a child to launder the lateral chain) are
 *      eventually refused. Pair counts expire like hop tags and are cleared by
 *      an operator message to either session.
 *
 * There is deliberately NO per-sender send-rate cap: a coordinator may fan a
 * message out to as many distinct sessions as its task needs, and loop
 * protection comes from the hop and pair budgets alone.
 *
 * Identity is the best-effort `x-jinn-caller-session` header (see mcp/identity.ts)
 * — these are anti-storm guards, NOT security boundaries (GRS-015 lesson: never
 * dress an environment value up as an authority gate).
 */

/**
 * Default max relay hops a lateral chain may traverse. Raised from 4 → 12: a
 * legitimate COO ↔ implementer ↔ QA loop is a 3-actor cycle whose round-trips
 * add up fast, and a cap of 4 refused real multi-round reviews. Override per
 * install via `sessions.lateralMaxHops` in config.yaml — the guards singleton is
 * reconfigured at boot and on hot-reload. This is still a bound, not a disable:
 * config is clamped to [LATERAL_MIN_HOPS, LATERAL_HOPS_HARD_CAP].
 */
export const LATERAL_MAX_HOPS = 12;
/** Lower bound for a configured hop cap (must allow at least one hop). */
export const LATERAL_MIN_HOPS = 1;
/** Hard ceiling for a configured hop cap — config can raise the bound but never
 *  remove the runaway-loop protection entirely. */
export const LATERAL_HOPS_HARD_CAP = 64;

/** Clamp a requested hop cap into the allowed range (anti-loop: never unbounded). */
export function clampLateralMaxHops(value: number): number {
  if (!Number.isFinite(value)) return LATERAL_MAX_HOPS;
  return Math.max(LATERAL_MIN_HOPS, Math.min(LATERAL_HOPS_HARD_CAP, Math.floor(value)));
}
/** A parent/child pair may exchange this many times the lateral hop cap of messages. */
export const PAIR_CAP_FACTOR = 4;
/** Inbound hop state older than this no longer penalizes a sender. */
export const LATERAL_HOP_TTL_MS = 30 * 60_000;
/** Lazy-prune cadence: every N guard operations, sweep expired state. */
export const PRUNE_EVERY_OPS = 256;

export type SendVerdict =
  | { ok: true; hops: number }
  | { ok: false; status: 400; error: string };

export interface SessionCommGuards {
  /** Check the hop budget for a sender and return the outbound hop count to
   *  stamp. There is no send-rate limit: any number of sends may pass. */
  checkSendAllowed(callerId: string, opts?: { parentSessionId?: string | null }): SendVerdict;
  /** Check the parent/child pair budget for a send between a session and its
   *  reporting parent (either direction); `hops` is the message's number in the
   *  pair's exchange. Does not touch the lateral hop state. */
  checkPairSend(callerId: string, targetId: string): SendVerdict;
  /** Record a delivered parent/child message with the number returned above. */
  recordPairDelivery(callerId: string, targetId: string, count: number): void;
  /** The current cap on messages between one parent/child pair. */
  pairMaxMessages(): number;
  /** Record that a lateral message with the given hop count reached a target. */
  recordDelivery(targetId: string, hops: number): void;
  /** Reset a session's relay chain (a genuine user/operator message arrived). */
  clearInboundHop(sessionId: string): void;
  /** Live map sizes — ops/tests introspection (spoof-flood no-growth proof). */
  stats(): { hopEntries: number; pairEntries: number };
  /** The current relay-hop cap for this guard instance. */
  maxHops(): number;
  /** Reconfigure the relay-hop cap (config apply at boot + hot-reload). Clamped
   *  to [LATERAL_MIN_HOPS, LATERAL_HOPS_HARD_CAP]. Does not touch storm state. */
  setMaxHops(value: number): void;
  /** Test/ops escape hatch: drop all in-memory hop state (NOT the hop cap). */
  reset(): void;
}

export function createSessionCommGuards(
  now: () => number = Date.now,
  initialMaxHops: number = LATERAL_MAX_HOPS,
): SessionCommGuards {
  const inboundHop = new Map<string, { hops: number; at: number }>();
  const pairCount = new Map<string, { a: string; b: string; count: number; at: number }>();
  const pairKey = (x: string, y: string): string => (x < y ? `${x}|${y}` : `${y}|${x}`);
  const pairCap = (): number => maxHops * PAIR_CAP_FACTOR;
  function pairCountOf(x: string, y: string): number {
    const rec = pairCount.get(pairKey(x, y));
    if (!rec) return 0;
    if (now() - rec.at > LATERAL_HOP_TTL_MS) {
      pairCount.delete(pairKey(x, y));
      return 0;
    }
    return rec.count;
  }
  let maxHops = clampLateralMaxHops(initialMaxHops);
  let opsSincePrune = 0;

  function inboundHopOf(id: string): number {
    const rec = inboundHop.get(id);
    if (!rec) return 0;
    if (now() - rec.at > LATERAL_HOP_TTL_MS) {
      inboundHop.delete(id);
      return 0;
    }
    return rec.hops;
  }

  /** Sweep expired hop tags every PRUNE_EVERY_OPS guard ops so idle sessions
   *  don't linger. Synchronous (concurrency invariant above). */
  function maybePrune(): void {
    if (++opsSincePrune < PRUNE_EVERY_OPS) return;
    opsSincePrune = 0;
    const t = now();
    for (const [id, rec] of inboundHop) {
      if (t - rec.at > LATERAL_HOP_TTL_MS) inboundHop.delete(id);
    }
    for (const [key, rec] of pairCount) {
      if (t - rec.at > LATERAL_HOP_TTL_MS) pairCount.delete(key);
    }
  }

  return {
    checkSendAllowed(callerId: string, opts?: { parentSessionId?: string | null }): SendVerdict {
      maybePrune();
      const hops = inboundHopOf(callerId) + 1;
      if (hops > maxHops) {
        const routes: string[] = [];
        if (opts?.parentSessionId) {
          routes.push(
            `send_to_session to your parent session ${opts.parentSessionId} (parent/child messages do not use this budget)`,
          );
        }
        routes.push(
          `a plain comment on the Todo you are working, if you have one (comment_work_item, without @mentioning the session you were talking to)`,
          `a summary to the operator`,
        );
        return {
          ok: false,
          status: 400,
          error:
            `hop budget exhausted: this message would be relay hop ${hops} of a lateral chain (max ${maxHops}). ` +
            `Stop forwarding — escalate instead. Routes that still work: ${routes.join("; ")}.`,
        };
      }
      return { ok: true, hops };
    },

    checkPairSend(callerId: string, targetId: string): SendVerdict {
      maybePrune();
      const count = pairCountOf(callerId, targetId) + 1;
      if (count > pairCap()) {
        return {
          ok: false,
          status: 400,
          error:
            `hop budget exhausted: this would be message ${count} between you and your parent/child session (max ${pairCap()}). ` +
            `The exchange is going in circles — stop and summarise: finish your turn with your conclusion, ` +
            `comment on the Todo you are working if you have one, or report to the operator.`,
        };
      }
      return { ok: true, hops: count };
    },

    recordPairDelivery(callerId: string, targetId: string, count: number): void {
      maybePrune();
      pairCount.set(pairKey(callerId, targetId), { a: callerId, b: targetId, count, at: now() });
    },

    pairMaxMessages(): number {
      return pairCap();
    },

    recordDelivery(targetId: string, hops: number): void {
      maybePrune();
      inboundHop.set(targetId, { hops, at: now() });
    },

    clearInboundHop(sessionId: string): void {
      inboundHop.delete(sessionId);
      for (const [key, rec] of pairCount) {
        if (rec.a === sessionId || rec.b === sessionId) pairCount.delete(key);
      }
    },

    stats(): { hopEntries: number; pairEntries: number } {
      return { hopEntries: inboundHop.size, pairEntries: pairCount.size };
    },

    maxHops(): number {
      return maxHops;
    },

    setMaxHops(value: number): void {
      maxHops = clampLateralMaxHops(value);
    },

    reset(): void {
      inboundHop.clear();
      pairCount.clear();
      opsSincePrune = 0;
    },
  };
}

/** The gateway's singleton guard state (api.ts routes use this instance). */
export const sessionCommGuards: SessionCommGuards = createSessionCommGuards();

export type LateralSendPlan =
  | { ok: true; prompt: string; displayMessage: string; hops: number; meta: AgentRelayMeta; parentLink: boolean }
  | { ok: false; status: 400; error: string };

export interface AgentRelayMeta {
  kind: "agent-relay";
  fromSessionId: string;
  fromLabel: string;
  fromEmployee?: string;
  hops: number;
  maxHops: number;
  fullMessage: string;
}

/** One-line word-boundary trim for the human-facing banner. */
export function clipSessionMessage(text: string, max = 220): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  const cut = oneLine.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
}

/**
 * Apply the lateral-send guards and build the injected message for an
 * agent-initiated send: the ENGINE prompt carries full sender identity, the hop
 * tag, the verbatim message, and a reply hint; `displayMessage` is the clean
 * banner the web UI shows. Deterministic text from record fields only.
 * On success the caller then `guards.recordDelivery(targetId, hops)` when it
 * accepts the send (conservative if a later step fails — an over-recorded hop
 * only tightens the budget).
 */
export function prepareLateralSend(opts: {
  caller: Session;
  targetSessionId: string;
  message: string;
  guards: SessionCommGuards;
  /** The caller's reporting parent session, if any (named in a budget refusal). */
  callerParentSessionId?: string | null;
  /** The send runs between a session and its reporting parent (either way): it
   *  is a reply or follow-up inside one request, not a relay, so it uses the
   *  pair budget instead of the lateral hop budget and does not tag the receiver. */
  parentLink?: boolean;
}): LateralSendPlan {
  const { caller, targetSessionId, message, guards } = opts;
  if (caller.id === targetSessionId) {
    return {
      ok: false,
      status: 400,
      error: "cannot message your own session — write your conclusion in your reply instead.",
    };
  }
  const verdict: SendVerdict = opts.parentLink
    ? guards.checkPairSend(caller.id, targetSessionId)
    : guards.checkSendAllowed(caller.id, { parentSessionId: opts.callerParentSessionId });
  if (!verdict.ok) return verdict;

  const senderLabel = caller.employee || caller.source || "session";
  // Relayed messages (hop > 1) carry the hop tag in the human banner too, so an
  // operator watching a chain sees how deep it runs; first-hop banners stay clean.
  const hopCap = opts.parentLink ? guards.pairMaxMessages() : guards.maxHops();
  const hopTag = ` [hop ${verdict.hops}/${hopCap}]`;
  const prompt =
    `📨 Message from session ${caller.id} (${senderLabel})${hopTag}:\n\n` +
    `${message}\n\n` +
    `To reply: send_to_session { sessionId: "${caller.id}" }. ` +
    `If this exchange is going in circles, stop and report to your parent session or the operator instead of forwarding.`;
  const displayMessage = `📨 From ${senderLabel}${verdict.hops > 1 ? hopTag : ""}: ${clipSessionMessage(message)}`;
  const meta: AgentRelayMeta = {
    kind: "agent-relay",
    fromSessionId: caller.id,
    fromLabel: senderLabel,
    ...(caller.employee ? { fromEmployee: caller.employee } : {}),
    hops: verdict.hops,
    maxHops: hopCap,
    fullMessage: message.slice(0, STRUCTURED_MESSAGE_BODY_MAX_CHARS),
  };
  return { ok: true, prompt, displayMessage, hops: verdict.hops, meta, parentLink: opts.parentLink === true };
}

/**
 * Is `sessionId` a strict descendant of `ancestorId`? Walks parentSessionId
 * upward with a cycle/depth guard. Self is NOT a descendant. Used to scope
 * agent-initiated stops to the caller's own subtree.
 */
export function isDescendantOf(
  sessionId: string,
  ancestorId: string,
  getSession: (id: string) => Session | undefined,
): boolean {
  const seen = new Set<string>([sessionId]);
  let current = getSession(sessionId);
  for (let depth = 0; depth < 64 && current?.parentSessionId; depth++) {
    const parentId = current.parentSessionId;
    if (parentId === ancestorId) return true;
    if (seen.has(parentId)) return false; // cycle
    seen.add(parentId);
    current = getSession(parentId);
  }
  return false;
}

/** Normalize a node header value to a trimmed string (first value wins). */
export function headerString(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed || undefined;
}

function hasHeader(headers: Record<string, string | string[] | undefined>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(headers, name);
}

/**
 * GRS-017 codex finding 2 — who is on the other end of a session-comm request?
 *
 *   - `session`: a declared caller identity (`x-jinn-caller-session`). For
 *     scoped tool writes, this is accepted only when the paired
 *     `x-jinn-session-capability` verifies against the gateway's per-session
 *     capability registry. The capability requirement keys off the identity
 *     claim itself, not the tool marker, so raw curl cannot spoof a session by
 *     omitting `x-jinn-tool-call`.
 *   - `unidentified-tool`: the tool-origin marker WITHOUT a verified bound
 *     identity. An MCP tool always runs on behalf of a session, so a marker with
 *     no identity/capability means the identity got LOST or spoofed — the routes
 *     must FAIL CLOSED (403), never fall through to the operator path.
 *   - `operator`: no session claim AND the caller has already proved gateway
 *     bearer/cookie authority. Absence of identity is never privilege.
 *   - `unauthenticated`: no verified operator auth and no scoped session
 *     identity. Mutation routes must fail this principal closed.
 */
export type CallerIdentity =
  | { kind: "operator" }
  | { kind: "session"; callerId: string }
  | { kind: "unidentified-tool"; reason: UnidentifiedToolReason }
  | { kind: "unauthenticated" };

/** Why a request was judged `unidentified-tool` — for the gateway's log, never the response. */
export type UnidentifiedToolReason =
  | "empty-header"
  | "no-caller-session"
  | "unknown-session"
  | "missing-capability"
  | "capability-mismatch";

const UNIDENTIFIED_TOOL_REASONS: Record<UnidentifiedToolReason, string> = {
  "empty-header": "an identity header is present but empty",
  "no-caller-session": "the tool-call marker came without a caller session header",
  "unknown-session": "the caller session header names no session this gateway knows",
  "missing-capability": "the caller session header came without a session capability",
  "capability-mismatch": "the session capability does not verify for that session against this gateway's key",
};

/** One line naming why an identified call was refused, for the gateway's log. */
export function describeUnidentifiedTool(reason: UnidentifiedToolReason): string {
  return UNIDENTIFIED_TOOL_REASONS[reason];
}

export interface CallerIdentityOptions {
  sessionExists?: (sessionId: string) => boolean;
  verifySessionCapability?: (sessionId: string, capability: string) => boolean;
  requireCapability?: boolean;
  operatorAuthenticated?: boolean;
}

export function resolveCallerIdentity(
  headers: Record<string, string | string[] | undefined>,
  options?: ((sessionId: string) => boolean) | CallerIdentityOptions,
): CallerIdentity {
  const opts: CallerIdentityOptions = typeof options === "function" ? { sessionExists: options } : options ?? {};
  const toolHeaderPresent = hasHeader(headers, TOOL_CALL_HEADER);
  const callerHeaderPresent = hasHeader(headers, CALLER_SESSION_HEADER);
  const toolMarker = headerString(headers[TOOL_CALL_HEADER]);
  const callerId = headerString(headers[CALLER_SESSION_HEADER]);
  if ((toolHeaderPresent && !toolMarker) || (callerHeaderPresent && !callerId)) {
    return { kind: "unidentified-tool", reason: "empty-header" };
  }
  const isToolCall = !!toolMarker;
  if (callerId) {
    if (opts.sessionExists && !opts.sessionExists(callerId)) return { kind: "unidentified-tool", reason: "unknown-session" };
    if (opts.requireCapability) {
      const capability = headerString(headers[CALLER_SESSION_CAPABILITY_HEADER]);
      if (!capability) return { kind: "unidentified-tool", reason: "missing-capability" };
      if (!opts.verifySessionCapability?.(callerId, capability)) return { kind: "unidentified-tool", reason: "capability-mismatch" };
    }
    return { kind: "session", callerId };
  }
  if (isToolCall) return { kind: "unidentified-tool", reason: "no-caller-session" };
  return opts.operatorAuthenticated ? { kind: "operator" } : { kind: "unauthenticated" };
}
