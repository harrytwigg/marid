import { TRANSCRIPT_ACTIVITY_META_KEY } from "../gateway/external-turns.js";
import { AUTO_COMPACT_BUDGET_HOLD_KEY, resolveAutoCompactPolicy, type AutoCompactPolicy } from "../shared/auto-compact-config.js";
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

const positive = (n: number | undefined): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

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

/**
 * The budget hold: left on a session by an auto-compaction that did not get it
 * under its budget — a long system prompt and toolset, a large verbatim tail.
 * `floor` is where the session landed: the size the compaction reported, or,
 * when the engine reports none (opencode), null until the next turn's reading
 * fills it in. That reading includes the turn's own growth, so on opencode a
 * heavy turn straight after a compaction raises the floor; the rearm bounds
 * the cost at a quarter of the budget past it.
 *
 * While held, the budget fires again only once the context has grown
 * {@link BUDGET_REARM_FRACTION} of the budget past both the budget and the
 * floor. So a budget the session cannot compact below costs one compaction per
 * that much growth rather than one on every turn, and growth always re-arms
 * it. A lower reading still over the budget (an operator's `/compact`, the
 * engine's own compaction) lowers the floor; one under the budget lifts the
 * hold. The cold-cache trigger ignores it: a compaction resets the engine's
 * activity, so that one cannot repeat on its own.
 */
export type BudgetHold = {
  floor: number | null;
  /** The engine whose compaction left it: another engine's context is not it. */
  engine: string;
};

/** How far past `max(budget, floor)` a held session must grow, as a share of
 *  the budget, before the budget fires again. */
export const BUDGET_REARM_FRACTION = 0.25;

/** What a decision asks the runner to write back: a new hold, `null` to lift
 *  it, absent to leave it as it is. */
interface HoldUpdate { holdUpdate?: BudgetHold | null }

export type AutoCompactDecision = HoldUpdate & (
  | { compact: false; skip: AutoCompactSkip }
  | { compact: true; trigger: "cold"; contextTokens: number; idleMs: number; policy: AutoCompactPolicy }
  | { compact: true; trigger: "budget"; contextTokens: number; budgetTokens: number; policy: AutoCompactPolicy }
);

export type AutoCompactGo = Extract<AutoCompactDecision, { compact: true }>;

export function readBudgetHold(session: Pick<Session, "transportMeta">): BudgetHold | undefined {
  const raw = session.transportMeta?.[AUTO_COMPACT_BUDGET_HOLD_KEY];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const { floor, engine } = raw as { floor?: number; engine?: unknown };
  return { floor: positive(floor) ? floor : null, engine: typeof engine === "string" ? engine : "" };
}

/** The context size at which a held session's budget fires again. */
export function budgetRearmTokens(budget: number, floor: number): number {
  return Math.max(budget, floor) + Math.ceil(budget * BUDGET_REARM_FRACTION);
}

/**
 * The hold a confirmed auto-compaction leaves, from the size it reported
 * afterwards: none when there is no budget or it landed under it, the size
 * when it landed at or over, and a pending floor when it reported none.
 */
export function holdAfterCompaction(policy: AutoCompactPolicy, engine: string, postTokens: number | undefined): BudgetHold | null {
  const budget = policy.maxContextTokens;
  if (budget === undefined) return null;
  if (!positive(postTokens)) return { floor: null, engine };
  return postTokens < budget ? null : { floor: postTokens, engine };
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
 * one compacts when its context has reached the budget — or, when the last
 * auto-compaction left it held at a floor, once it has grown a quarter of the
 * budget past the floor (see the hold above).
 */
export function decideAutoCompaction(input: AutoCompactInput): AutoCompactDecision {
  const policy = resolveAutoCompactPolicy(input.config, input.engine);
  if (!policy?.enabled) return { compact: false, skip: "disabled" };
  const skip = turnSkip(input);
  if (skip) return { compact: false, skip };

  const contextTokens = input.session.lastContextTokens ?? undefined;
  if (!positive(contextTokens)) return { compact: false, skip: "context-unknown" };
  const cold = decideCold(input, policy, contextTokens);
  if (cold.compact) return cold;
  const { decision, holdUpdate } = decideBudget(input, policy, contextTokens);
  return { ...(decision ?? cold), ...(holdUpdate !== undefined ? { holdUpdate } : {}) };
}

/**
 * The budget trigger, and what becomes of the hold. No decision when there is
 * no budget or the context is under it — the cold-cache answer then stands.
 */
function decideBudget(
  input: AutoCompactInput,
  policy: AutoCompactPolicy,
  contextTokens: number,
): { decision?: AutoCompactDecision } & HoldUpdate {
  const budget = policy.maxContextTokens;
  const found = readBudgetHold(input.session);
  // Another engine's compaction says nothing about this engine's context.
  const hold = found?.engine === input.engine ? found : undefined;
  const lift = found ? { holdUpdate: null } : {};
  // Under the budget, or no budget at all: nothing to fire, nothing to hold.
  if (budget === undefined || contextTokens < budget) return lift;
  if (!hold) return { decision: { compact: true, trigger: "budget", contextTokens, budgetTokens: budget, policy }, ...lift };
  // The first reading since a compaction that reported no size is where it
  // landed; a lower reading since (a manual or the engine's own compaction)
  // is where it is now.
  const floor = hold.floor === null ? contextTokens : Math.min(hold.floor, contextTokens);
  const moved = floor !== hold.floor ? { holdUpdate: { floor, engine: hold.engine } } : {};
  if (contextTokens < budgetRearmTokens(budget, floor)) return { decision: { compact: false, skip: "budget-held" }, ...moved };
  // Grown far enough past where it landed: compact again. A confirmed
  // compaction sets the next hold; a failed one leaves none, so the next turn retries.
  return { decision: { compact: true, trigger: "budget", contextTokens, budgetTokens: budget, policy }, holdUpdate: null };
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
