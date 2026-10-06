import { TRANSCRIPT_ACTIVITY_META_KEY } from "../gateway/external-turns.js";
import { resolveAutoCompactPolicy, type AutoCompactPolicy } from "../shared/auto-compact-config.js";
import { isRawEngineCommand } from "../shared/skill-commands.js";
import type { CompactionStats, JinnConfig, Session } from "../shared/types.js";
import { formatTokens } from "./compact-command.js";
import { getEngineSessionRef } from "./registry.js";
import { compactionUnsupported, type CompactionUnsupported } from "./self-compaction.js";

/**
 * Auto-compaction: before a turn runs on a long session whose prompt cache
 * has expired, or whose context has passed its budget, compact it first.
 *
 * Resuming a session after its engine's prompt cache has gone cold re-bills the
 * whole context at the full input price, and every turn after that re-reads it.
 * Compacting first costs one summarizing call over that same context — the
 * price the waiting turn was about to pay anyway — and the waiting turn and
 * every one after it then run on the summary instead.
 *
 * A session that never goes cold never takes that path, and an engine's own
 * compaction waits for the model's context ceiling: opencode's fires at
 * `limit.context − maxOutput` (~968k on a 1M model) and ignores its
 * `compaction.reserved` unless the provider declares `limit.input`. So the
 * budget (`maxContextTokens`) is Jinn's: at or above it, the turn compacts
 * first whatever the cache.
 *
 * Off unless `engines.<engine>.autoCompact.enabled` is true. Only claude and
 * opencode (server mode) can compact; everywhere else this is a no-op that
 * sends nothing to a model.
 *
 * This module is the pure decision and the words; `turn/auto-compact.ts` runs
 * it, inside the turn it precedes.
 */

function isoMs(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * When this session's engine conversation last touched the provider, which is
 * when its prompt cache was last refreshed: the latest turn Jinn settled on it
 * (`lastSyncedAt`, written with every receipt that files the engine session)
 * or, for Claude, the latest turn typed straight into its terminal that Jinn
 * has synced. Undefined when nothing says — never guessed as cold.
 *
 * `lastActivity` cannot answer this: the turn being decided has already
 * stamped it with "now", and it moves on engine-less events too.
 */
export function lastEngineActivityMs(session: Session, engine: string): number | undefined {
  const synced = isoMs(getEngineSessionRef(session, engine).lastSyncedAt);
  const meta = (session.transportMeta ?? {}) as Record<string, unknown>;
  const typed = engine === "claude" ? isoMs(meta[TRANSCRIPT_ACTIVITY_META_KEY]) : undefined;
  if (synced === undefined) return typed;
  if (typed === undefined) return synced;
  return Math.max(synced, typed);
}

export type AutoCompactSkip =
  | "disabled"
  | CompactionUnsupported
  | "compaction-turn"
  | "raw-command"
  | "engine-switch"
  | "no-engine-session"
  | "context-unknown"
  | "context-small"
  | "activity-unknown"
  | "cache-warm"
  | "budget-held";

/** Why a turn compacts first: its cache went cold, or its context passed the budget. */
export type AutoCompactTrigger = "cold" | "budget";

export type AutoCompactDecision =
  | { compact: false; skip: AutoCompactSkip }
  | { compact: true; trigger: "cold"; contextTokens: number; idleMs: number; policy: AutoCompactPolicy }
  | { compact: true; trigger: "budget"; contextTokens: number; budgetTokens: number; policy: AutoCompactPolicy };

export type AutoCompactGo = Extract<AutoCompactDecision, { compact: true }>;

/**
 * Set on a session by every confirmed auto-compaction, and cleared once a turn
 * reads its context below the budget again. While it is set the budget does
 * not fire, so a budget the session cannot compact below — a long system
 * prompt and toolset, a large verbatim tail — costs one compaction, not one on
 * every turn. The cold-cache trigger ignores it: a compaction resets the
 * engine's activity, so that one cannot repeat on its own.
 */
export const AUTO_COMPACT_BUDGET_HOLD_KEY = "autoCompactBudgetHold";

export function budgetHeld(session: Pick<Session, "transportMeta">): boolean {
  return session.transportMeta?.[AUTO_COMPACT_BUDGET_HOLD_KEY] === true;
}

/** Whether the session's hold has served its purpose: the meter now reads
 *  below the budget (or there is no budget). An unread meter proves nothing. */
export function budgetHoldReleased(session: Pick<Session, "transportMeta" | "lastContextTokens">, policy: AutoCompactPolicy | undefined): boolean {
  if (!budgetHeld(session)) return false;
  const tokens = session.lastContextTokens;
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) return false;
  return policy?.maxContextTokens === undefined || tokens < policy.maxContextTokens;
}

export interface AutoCompactInput {
  config: Pick<JinnConfig, "engines">;
  /** The live session row, not the turn's snapshot: an earlier turn's receipt
   *  may have moved its meter and engine ref since the snapshot was taken. */
  session: Session;
  engine: string;
  opencodeMode: string | undefined;
  /** The operator's prompt for the turn, as sent. */
  prompt: string;
  /** The turn is itself a compaction (`/compact`, a self-compaction). */
  compactionTurn: boolean;
  /** The turn carries an engine-switch transcript, so the engine's own
   *  conversation is behind the chat and the meter describes another engine. */
  syncRequested: boolean;
  now: number;
}

/** Why this turn is not one to compact in front of, whatever the session's
 *  size and age; undefined when it is. */
function turnSkip(input: AutoCompactInput): AutoCompactSkip | undefined {
  const unsupported = compactionUnsupported(input.engine, input.opencodeMode);
  if (unsupported) return unsupported;
  // Compacting in front of a compaction is the same work twice; in front of
  // another native command (/clear, /model) it is work thrown away.
  if (input.compactionTurn) return "compaction-turn";
  if (isRawEngineCommand(input.engine, input.prompt)) return "raw-command";
  if (input.syncRequested) return "engine-switch";
  if (!getEngineSessionRef(input.session, input.engine).id) return "no-engine-session";
  return undefined;
}

/** The cold-cache trigger alone: long enough, and idle past the window. */
function decideCold(input: AutoCompactInput, policy: AutoCompactPolicy, contextTokens: number): AutoCompactDecision {
  if (contextTokens < policy.minContextTokens) return { compact: false, skip: "context-small" };
  const lastActivity = lastEngineActivityMs(input.session, input.engine);
  if (lastActivity === undefined) return { compact: false, skip: "activity-unknown" };
  const idleMs = input.now - lastActivity;
  if (idleMs < policy.cacheWindowSeconds * 1000) return { compact: false, skip: "cache-warm" };
  return { compact: true, trigger: "cold", contextTokens, idleMs, policy };
}

/**
 * Whether to compact before this turn. Every "no" is a reason, so a log line can
 * say why a session that looked cold was left alone. Nothing here reads more
 * than the session row.
 *
 * A cold session compacts as cold whatever its size against the budget; a warm
 * one compacts when its context has reached the budget, unless the last
 * auto-compaction has not yet brought it back under (see the hold above).
 */
export function decideAutoCompaction(input: AutoCompactInput): AutoCompactDecision {
  const policy = resolveAutoCompactPolicy(input.config, input.engine);
  if (!policy?.enabled) return { compact: false, skip: "disabled" };
  const skip = turnSkip(input);
  if (skip) return { compact: false, skip };

  const contextTokens = input.session.lastContextTokens;
  if (typeof contextTokens !== "number" || !Number.isFinite(contextTokens) || contextTokens <= 0) {
    return { compact: false, skip: "context-unknown" };
  }
  const cold = decideCold(input, policy, contextTokens);
  if (cold.compact) return cold;

  const budget = policy.maxContextTokens;
  if (budget === undefined || contextTokens < budget) return cold;
  if (budgetHeld(input.session)) return { compact: false, skip: "budget-held" };
  return { compact: true, trigger: "budget", contextTokens, budgetTokens: budget, policy };
}

/**
 * Sessions whose turn is compacting in front of its message right now. A new
 * operator message waits for that rather than cutting it off, as it waits for an
 * operator's `/compact`: interrupting would throw the compaction away and the
 * next turn, still cold, would only start it again. A stop still stops it.
 * In-memory on purpose — a gateway restart ends every turn anyway.
 */
const autoCompacting = new Set<string>();

export function markAutoCompacting(sessionId: string, active: boolean): void {
  if (active) autoCompacting.add(sessionId);
  else autoCompacting.delete(sessionId);
}

export function isAutoCompacting(sessionId: string): boolean {
  return autoCompacting.has(sessionId);
}

const CHILDREN_LISTED = 8;

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The compaction turn's prompt. One line, because Claude Code takes it in its
 * composer as a slash command, where a newline would submit early. opencode's
 * summarize ignores the focus; it is harmless there.
 *
 * Child sessions still running are named, because a parent's side of a
 * delegation — which child owes what — is exactly what a summary tends to
 * drop, and their callbacks are about to arrive into the compacted context.
 */
export function buildAutoCompactCommand(
  childrenInFlight: Pick<Session, "id" | "employee">[],
  trigger: AutoCompactTrigger = "cold",
): string {
  const why = trigger === "budget"
    ? "this session's context has passed its budget"
    : "this session sat idle past its prompt-cache window";
  let command = `/compact Automatic compaction: ${why} and a new message is `
    + "waiting, so the context is being summarized before it runs. Keep the task and its goal, decisions made and why, "
    + "exact identifiers (Todo and session ids, branches, file paths, PRs), work delegated and still awaited, "
    + "and open problems. Drop raw tool output and superseded attempts.";
  if (childrenInFlight.length > 0) {
    const listed = childrenInFlight.slice(0, CHILDREN_LISTED)
      .map((child) => child.employee ? `${child.id} (${child.employee})` : child.id);
    const more = childrenInFlight.length - listed.length;
    command += ` Child sessions still in flight, whose results will arrive after this: ${listed.join(", ")}`
      + (more > 0 ? ` and ${more} more.` : ".");
  }
  return oneLine(command);
}

function formatIdle(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (minutes < 120) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
}

function describeWindow(policy: AutoCompactPolicy): string {
  return formatIdle(policy.cacheWindowSeconds * 1000);
}

/** The live status line while the compaction runs. */
export function autoCompactStatus(decision: AutoCompactGo): string {
  if (decision.trigger === "budget") {
    return `🗜️ Session at ${formatTokens(decision.contextTokens)} of context `
      + `(past its budget of ${formatTokens(decision.budgetTokens)}) — compacting it before the next message…`;
  }
  return `🗜️ Session idle ${formatIdle(decision.idleMs)} with ${formatTokens(decision.contextTokens)} of context `
    + `(past its ${describeWindow(decision.policy)} cache window) — compacting it before the next message…`;
}

const positive = (n: number | undefined): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

/** What the chat is told once the compaction confirmed. */
export function autoCompactDoneNotice(decision: AutoCompactGo, stats: CompactionStats | undefined): string {
  const pre = positive(stats?.preTokens) ? stats!.preTokens : decision.contextTokens;
  const size = positive(stats?.postTokens)
    ? `${formatTokens(pre)} → ${formatTokens(stats!.postTokens)}`
    : `it was ${formatTokens(pre)}`;
  if (decision.trigger === "budget") {
    return `🗜️ Auto-compacted this session before the next message (${size}; past its context budget of `
      + `${formatTokens(decision.budgetTokens)}).`;
  }
  return `🗜️ Auto-compacted this cold session before the next message (${size}; idle ${formatIdle(decision.idleMs)}, `
    + `past the ${describeWindow(decision.policy)} cache window).`;
}

/** What the chat is told when the compaction did not happen. The message runs
 *  anyway: a compaction is an optimization, never a gate on the work. */
export function autoCompactFailedNotice(reason: string, trigger: AutoCompactTrigger = "cold"): string {
  const flat = oneLine(reason);
  const clipped = flat.length > 200 ? `${flat.slice(0, 199).trimEnd()}…` : flat;
  const what = trigger === "budget" ? "this session" : "this cold session";
  return `⚠️ Auto-compaction of ${what} didn't complete (${clipped}), so the next message runs on the full context.`;
}
