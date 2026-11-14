/**
 * The in-memory registry of open talk sessions — one source of truth, keyed by
 * talk-session id.
 *
 * Nothing here is bound to a socket. A session survives a page navigation
 * because the client keeps its id and re-attaches. A missed heartbeat parks the
 * provider connection without destroying the recoverable Talk history.
 */
import { randomUUID } from "node:crypto";
import {
  TALK_CONTEXT_BUDGET_TOKENS,
  contextTokens,
  estimateTokens,
  handoffSuggested,
  truncateTurns,
} from "./context.js";
import { allTools } from "./tools.js";
import type {
  TalkActionRecord,
  TalkInterruptionRecord,
  TalkSession,
  TalkSessionReadOptions,
  TalkSessionStore,
  TalkTurnRecord,
  VisualCaptureReceipt,
} from "./types.js";

/** Three missed 30-second heartbeats. */
export const TALK_SESSION_TTL_MS = 90_000;

/** Far more writes than a spoken conversation produces. The cap is here so a
 *  looping client cannot grow the log without bound, not to bound the audit. */
export const TALK_ACTION_LOG_LIMIT = 500;
export const TALK_INTERRUPTION_LOG_LIMIT = 500;

/** Carries the HTTP status the router should answer with, so state rules live
 *  here rather than being re-derived at every route. */
export class TalkSessionError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "TalkSessionError";
    this.status = status;
  }
}

export interface OpenTalkSessionOptions {
  /** The `sessions` row this talk session bills through. */
  sessionId: string;
  model: string;
  /** The standing brief this session opens with. */
  brief: string;
  /** Expiry of the credential minted for this open, in provider seconds. */
  tokenExpiresAt: number;
  /** Browser identity supplied outside provider tool arguments. */
  browserInstanceId?: string;
}

export interface TalkTurnResult {
  contextTokens: number;
  /** Cumulative over the session, not just this turn. */
  truncatedTurns: number;
  handoffSuggested: boolean;
}

function copySession(session: TalkSession): TalkSession {
  return structuredClone(session);
}

class MemoryTalkSessionStore implements TalkSessionStore {
  private readonly sessions = new Map<string, TalkSession>();

  get(id: string, options: TalkSessionReadOptions = {}): TalkSession | undefined {
    const session = this.sessions.get(id);
    return session && (options.includeClosed || session.state !== "closed") ? copySession(session) : undefined;
  }

  list(options: TalkSessionReadOptions = {}): TalkSession[] {
    return [...this.sessions.values()]
      .filter((session) => options.includeClosed || session.state !== "closed")
      .map(copySession);
  }

  save(session: TalkSession): void {
    this.sessions.set(session.id, copySession(session));
  }
}

export class TalkSessionRegistry {
  private readonly store: TalkSessionStore;
  private readonly now: () => number;

  constructor(now: () => number = Date.now, store: TalkSessionStore = new MemoryTalkSessionStore()) {
    this.now = now;
    this.store = store;
  }

  open(options: OpenTalkSessionOptions): TalkSession {
    const at = this.now();
    const session: TalkSession = {
      id: randomUUID(),
      browserInstanceId: options.browserInstanceId ?? randomUUID(),
      credentialGeneration: 1,
      sessionId: options.sessionId,
      state: "live",
      model: options.model,
      brief: options.brief,
      openedAt: at,
      lastSeenAt: at,
      turns: [],
      truncatedTurns: 0,
      tokenExpiresAt: options.tokenExpiresAt,
      exposedTools: allTools().map((tool) => tool.name),
      actions: [],
      interruptions: [],
      visualReceiptKeys: [],
    };
    this.store.save(session);
    return session;
  }

  get(id: string): TalkSession | undefined {
    return this.store.get(id);
  }

  park(id: string): TalkSession {
    const session = this.require(id);
    if (session.state === "parked") {
      throw new TalkSessionError(409, "This talk session is already parked — resume it before parking again.");
    }
    session.state = "parked";
    session.lastSeenAt = this.now();
    this.store.save(session);
    return session;
  }

  resume(id: string): TalkSession {
    const session = this.require(id);
    if (session.state === "live") {
      throw new TalkSessionError(409, "This talk session is already live — park it before resuming.");
    }
    session.state = "live";
    session.lastSeenAt = this.now();
    this.store.save(session);
    return session;
  }

  /** Remember the credential just handed out, so the next one can be required to
   *  outlive it. */
  recordToken(id: string, expiresAt: number): void {
    const session = this.require(id);
    session.tokenExpiresAt = expiresAt;
    session.credentialGeneration += 1;
    this.store.save(session);
  }

  heartbeat(id: string): TalkSession {
    const session = this.require(id);
    session.lastSeenAt = this.now();
    this.store.save(session);
    return session;
  }

  /** Append one completed exchange and re-apply the rolling truncation. */
  appendTurn(
    id: string,
    text: string,
    budgetTokens = TALK_CONTEXT_BUDGET_TOKENS,
    visualReceipts: readonly VisualCaptureReceipt[] = [],
  ): TalkTurnResult {
    const session = this.require(id);
    const accepted = visualReceipts.filter((receipt) => {
      const key = `${receipt.requestKey}:${receipt.contextRevision}:${receipt.reason}`;
      if (session.visualReceiptKeys.includes(key)) return false;
      session.visualReceiptKeys.push(key);
      return true;
    });
    if (session.visualReceiptKeys.length > TALK_ACTION_LOG_LIMIT) {
      session.visualReceiptKeys.splice(0, session.visualReceiptKeys.length - TALK_ACTION_LOG_LIMIT);
    }
    const turn: TalkTurnRecord = {
      at: this.now(),
      text,
      estimatedTokens: estimateTokens(text),
      ...(accepted.length ? { visualReceipts: accepted } : {}),
    };
    const truncated = truncateTurns([...session.turns, turn], budgetTokens);
    session.turns = truncated.turns;
    session.truncatedTurns += truncated.dropped;
    session.lastSeenAt = turn.at;
    this.store.save(session);
    return {
      contextTokens: contextTokens(session.turns),
      truncatedTurns: session.truncatedTurns,
      handoffSuggested: handoffSuggested(turn),
    };
  }

  /** Log one attempted write. The id and timestamp are the registry's to assign
   *  so no caller can name or date its own entry. */
  recordAction(id: string, input: Omit<TalkActionRecord, "id" | "at">): TalkActionRecord {
    const session = this.require(id);
    const action: TalkActionRecord = { ...input, id: randomUUID(), at: this.now() };
    session.actions.push(action);
    // Oldest first, as with the turn budget: the newest attempt is the one an
    // operator is about to ask about.
    if (session.actions.length > TALK_ACTION_LOG_LIMIT) {
      session.actions.splice(0, session.actions.length - TALK_ACTION_LOG_LIMIT);
    }
    this.store.save(session);
    return action;
  }

  recordInterruption(id: string, input: Omit<TalkInterruptionRecord, "at">): TalkInterruptionRecord {
    const session = this.require(id);
    const interruption: TalkInterruptionRecord = { ...input, at: this.now() };
    const interruptions = session.interruptions ?? (session.interruptions = []);
    interruptions.push(interruption);
    if (interruptions.length > TALK_INTERRUPTION_LOG_LIMIT) {
      interruptions.splice(0, interruptions.length - TALK_INTERRUPTION_LOG_LIMIT);
    }
    this.store.save(session);
    return interruption;
  }

  /** Idempotent: terminal rows remain stored for normal chat history and audit,
   * while the public registry no longer exposes them as resumable. */
  close(id: string): void {
    const session = this.store.get(id);
    if (!session) return;
    session.state = "closed";
    session.lastSeenAt = this.now();
    this.store.save(session);
  }

  /** Park every live session whose last heartbeat predates the TTL. Returns the
   *  ids parked so the caller can release their provider connections. */
  reap(): string[] {
    const cutoff = this.now() - TALK_SESSION_TTL_MS;
    const expired = this.store.list()
      .filter((session) => session.state === "live" && session.lastSeenAt < cutoff);
    for (const session of expired) {
      session.state = "parked";
      this.store.save(session);
    }
    return expired.map((session) => session.id);
  }

  private require(id: string): TalkSession {
    const session = this.store.get(id);
    if (!session) {
      throw new TalkSessionError(404, `Talk session ${id} does not exist — it was closed or never opened.`);
    }
    return session;
  }
}
