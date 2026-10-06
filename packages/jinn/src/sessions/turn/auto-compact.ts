import { opencodeMode } from "../../engines/opencode-server.js";
import { logger } from "../../shared/logger.js";
import { detectRateLimit } from "../../shared/rateLimit.js";
import type { EngineResult, Session } from "../../shared/types.js";
import { AUTO_COMPACT_BUDGET_HOLD_KEY } from "../../shared/auto-compact-config.js";
import {
  autoCompactDoneNotice,
  autoCompactFailedNotice,
  autoCompactStatus,
  buildAutoCompactCommand,
  decideAutoCompaction,
  holdAfterCompaction,
  markAutoCompacting,
  type AutoCompactDecision,
  type AutoCompactGo,
  type BudgetHold,
} from "../auto-compaction.js";
import type { PartialStreamWriter } from "../partial-stream.js";
import {
  deletePartialMessages,
  getSession,
  listChildSessions,
  nextEngineSessionFields,
  recordTurnAccounting,
  updateSessionForAttempt,
  type UpdateSessionFields,
} from "../registry.js";
import { runEngineAttempt, type EngineAttempt } from "./engine-run.js";
import { settleTurn } from "./completion.js";
import { preflightTurn } from "./preflight.js";
import { clearSupersededTurnMeta, isTurnSuperseded, retainUnseenInterruptedPrompt } from "./superseded.js";
import type { TurnPlan, TurnRun, TurnSurface } from "./types.js";
import { reportedSessionStatus } from "../background-work.js";

/**
 * Runs auto-compaction (see `../auto-compaction.ts`) INSIDE the turn
 * it precedes, between that turn's preflight and its engine run.
 *
 * Inside the turn, rather than as a turn of its own queued in front, because
 * that is what makes the three ordering guarantees free:
 *   - every transport — web, CLI view, connectors, cron, delegation callbacks,
 *     workflow phases — reaches an engine through `runTurn`, so all of them get
 *     it, and nothing else does;
 *   - the turn already owns the session's queue slot, so nothing can run
 *     between the compaction and the message it was for, and a message queued
 *     meanwhile waits behind both, as it would behind any turn (the bug
 *     self-compaction once had was a queued turn landing BETWEEN two turns);
 *   - it is decided once per turn, and a confirmed compaction resets the meter,
 *     so the next turn cannot compact again.
 * It is also not a turn in its own right: no receipt, no parent callback, no
 * second attempt. The turn it precedes reports as it always would.
 *
 * Failure never costs the message. A compaction that errors, hits a usage limit,
 * or is never confirmed is logged and noticed, and the turn runs as planned on
 * the full context. Only a preemption — a newer message, a stop — ends the turn
 * here, exactly as it would have ended the engine run it was about to start.
 */

export type PreTurnCompaction =
  /** Run the turn with this plan (the original, or one resuming a new engine id). */
  | { kind: "run"; plan: TurnPlan }
  /** A stop or a newer message took the turn while it compacted. */
  | { kind: "preempted" };

/** The compaction's stream is not the turn's answer: nothing of it is kept. */
const DISCARDED_STREAM: PartialStreamWriter = { persist() {}, finish() {} };

/** The chat sees the compaction's status and the meter moving, not its prose. */
function compactionSurface(surface: TurnSurface): TurnSurface {
  return {
    ...surface,
    delta: (delta) => {
      if (delta.type === "status" || delta.type === "context") surface.delta(delta);
    },
  };
}

function childrenInFlight(sessionId: string): Session[] {
  try {
    return listChildSessions(sessionId).filter((child) => {
      const status = reportedSessionStatus(child);
      return status === "running" || status === "waiting";
    });
  } catch (err) {
    logger.warn(`[auto-compact] ${sessionId}: could not list child sessions: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

export type AutoCompactOutcome = "compacted" | "unconfirmed" | "failed" | "rate-limited" | "preempted" | "not-planned";

/** One auto-compaction in progress: what was decided, and when it started. */
interface Pending {
  run: TurnRun;
  decision: AutoCompactGo;
  startedAt: number;
}

/** A value for the log line; `-` when there is none. An empty value would let
 *  the logger's secret scrubber take the next field as its value. */
const field = (value: number | string | undefined): string => (value === undefined ? "-" : String(value));

function resultFields(result: Pick<EngineResult, "compaction" | "cost"> | undefined): string[] {
  const stats = result?.compaction;
  return [
    `pre=${field(stats?.preTokens)}`,
    `post=${field(stats?.postTokens)}`,
    `costUsd=${field(result?.cost?.toFixed(4))}`,
  ];
}

function triggerFields(decision: AutoCompactGo): string[] {
  return decision.trigger === "budget"
    ? [`trigger=budget`, `budget=${decision.budgetTokens}`]
    : [`trigger=cold`, `idleSec=${Math.round(decision.idleMs / 1000)}`, `windowSec=${decision.policy.cacheWindowSeconds}`];
}

/**
 * One greppable line per auto-compaction, so the saving can be checked later
 * against the spend ledger (the compaction's own cost is recorded there too).
 * Sizes are in tokens. No key may contain "token": the logger's secret
 * scrubber blanks any `…token…=` value, whatever its case.
 */
export function autoCompactLogLine(
  fields: { sessionId: string; engine: string; outcome: AutoCompactOutcome; decision: AutoCompactGo; durationMs: number },
  result?: Pick<EngineResult, "compaction" | "cost">,
): string {
  return "[auto-compact] " + [
    `session=${fields.sessionId}`,
    `engine=${fields.engine}`,
    `outcome=${fields.outcome}`,
    ...triggerFields(fields.decision),
    `context=${fields.decision.contextTokens}`,
    ...resultFields(result),
    `durationMs=${fields.durationMs}`,
  ].join(" ");
}

function logAutoCompaction(pending: Pending, outcome: AutoCompactOutcome, result?: Pick<EngineResult, "compaction" | "cost" | "error">): void {
  const { run, decision } = pending;
  const line = autoCompactLogLine(
    { sessionId: run.input.session.id, engine: run.plan.engineName, outcome, decision, durationMs: Date.now() - pending.startedAt },
    result,
  );
  if (outcome === "compacted" || outcome === "preempted") logger.info(line);
  else logger.warn(`${line} error=${JSON.stringify((result?.error ?? "").slice(0, 300))}`);
}

/** A stop, a newer message, a workflow interruption or another turn took the
 *  attempt while the compaction ran. */
function wasPreempted(run: TurnRun, live: Session | undefined, result: EngineResult): boolean {
  if (!live || live.engine !== run.plan.engineName) return true;
  if (result.error?.startsWith("Interrupted")) return true;
  if (live.attemptToken !== run.input.attemptToken || live.status !== "running") return true;
  return isTurnSuperseded(live.id, run.turnStartedAt);
}

/** The session's `transportMeta` with its budget hold set, or lifted (`null`). */
function withBudgetHold(current: Session, hold: BudgetHold | null): UpdateSessionFields {
  const { [AUTO_COMPACT_BUDGET_HOLD_KEY]: _previous, ...rest } = current.transportMeta ?? {};
  return { transportMeta: hold ? { ...rest, [AUTO_COMPACT_BUDGET_HOLD_KEY]: hold } : rest };
}

/**
 * Record a confirmed compaction on the session, fenced to this attempt: its
 * cost, the engine session it compacted (so `lastSyncedAt` says the cache is
 * warm again), the meter's new reading — the size after, or nothing when
 * the engine reported none, so the meter never shows the pre-compaction size
 * as current — and the budget hold, when the compaction did not get the
 * session under its budget. Returns the engine id the turn should now resume.
 */
function recordCompaction(run: TurnRun, compactPlan: TurnPlan, attempt: EngineAttempt, decision: AutoCompactGo): string | undefined {
  const { result } = attempt;
  const postTokens = result.compaction?.postTokens ?? result.contextTokens;
  const meter = typeof postTokens === "number" ? postTokens : null;
  const sessionId = run.input.session.id;
  recordTurnAccounting(sessionId, { cost: result.cost, numTurns: result.numTurns, ...(compactPlan.model ? { model: compactPlan.model } : {}) });
  const nativeId = result.sessionId?.trim() || compactPlan.resumeNativeId;
  updateSessionForAttempt(sessionId, run.input.attemptToken, (current): UpdateSessionFields => ({
    ...(nativeId
      ? nextEngineSessionFields(current, compactPlan.engineName, nativeId, {
        model: compactPlan.model,
        effortLevel: compactPlan.effortLevel,
        platformContextFingerprint: attempt.fingerprint,
        lastSyncedAt: new Date().toISOString(),
      })
      : {}),
    lastContextTokens: meter,
    ...withBudgetHold(current, holdAfterCompaction(decision.policy, compactPlan.engineName, meter ?? undefined)),
  }));
  return nativeId;
}

/** The turn's plan, resuming the engine session the compaction left behind. */
function planAfterCompaction(plan: TurnPlan, nativeId: string | undefined): TurnPlan {
  if (!nativeId || nativeId === plan.resumeNativeId) return plan;
  return { ...plan, resumeSessionId: nativeId, resumeNativeId: nativeId };
}

async function runCompaction(run: TurnRun, compactPlan: TurnPlan): Promise<EngineAttempt | Error> {
  markAutoCompacting(run.input.session.id, true);
  try {
    return await runEngineAttempt({
      input: run.input,
      plan: compactPlan,
      surface: compactionSurface(run.surface),
      heartbeat: run.heartbeat,
      partialStream: DISCARDED_STREAM,
      turnStartedAt: Date.now(),
      model: compactPlan.model,
    });
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  } finally {
    markAutoCompacting(run.input.session.id, false);
  }
}

type Verdict =
  | { outcome: "compacted" }
  | { outcome: "preempted" }
  | { outcome: "rate-limited" | "failed" | "unconfirmed"; reason: string };

/** How the compaction ended, in the order that matters: a preemption first
 *  (whatever else it says, the turn is gone), then a limit, then anything short
 *  of a confirmed compaction. */
function judge(run: TurnRun, result: EngineResult): Verdict {
  if (wasPreempted(run, getSession(run.input.session.id), result)) return { outcome: "preempted" };
  // A usage limit is not this turn's to handle: the turn runs next, meets the
  // same limit, and takes the ordinary rate-limit path (wait, or fall back).
  if (detectRateLimit(result).limited) return { outcome: "rate-limited", reason: "the engine is at its usage limit" };
  if (result.error) return { outcome: "failed", reason: result.error };
  if (!result.compaction) return { outcome: "unconfirmed", reason: "the engine never confirmed a compaction" };
  return { outcome: "compacted" };
}

function decide(run: TurnRun): AutoCompactDecision {
  const { input, plan } = run;
  const decision = decideAutoCompaction({
    config: input.config,
    // The live row: an earlier turn's receipt has moved the meter and the
    // engine ref since this turn's snapshot was taken.
    session: getSession(input.session.id) ?? input.session,
    engine: plan.engineName,
    opencodeMode: opencodeMode(input.config.engines.opencode),
    prompt: input.prompt,
    compactionTurn: plan.compaction,
    syncRequested: plan.syncRequested,
    now: Date.now(),
  });
  // The decision moved the hold (filled its floor, or lifted it): write that
  // back, fenced to this attempt like everything else the turn records.
  if (decision.holdUpdate !== undefined) {
    const hold = decision.holdUpdate;
    updateSessionForAttempt(input.session.id, input.attemptToken, (current) => withBudgetHold(current, hold));
  }
  return decision;
}

/**
 * Compact this turn's session first when it is long and its cache has gone
 * cold, or its context has passed its budget; otherwise hand the plan straight
 * back. See the module comment.
 */
export async function compactColdSessionFirst(run: TurnRun): Promise<PreTurnCompaction> {
  const decision = decide(run);
  if (decision.compact) return await compactThenRun({ run, decision, startedAt: Date.now() });
  if (decision.skip !== "disabled") logger.debug(`[auto-compact] ${run.input.session.id}: not compacting (${decision.skip})`);
  return { kind: "run", plan: run.plan };
}

async function compactThenRun(pending: Pending): Promise<PreTurnCompaction> {
  const { run, decision } = pending;
  const { input, plan } = run;
  const sessionId = input.session.id;
  // The same preflight an operator's `/compact` gets, so the compaction runs
  // exactly as that one does: verbatim, with no refresh or held prompt folded in.
  const compactPlan = preflightTurn({
    ...input,
    session: getSession(sessionId) ?? input.session,
    prompt: buildAutoCompactCommand(childrenInFlight(sessionId), decision.trigger),
  });
  if (!compactPlan.ok || !compactPlan.compaction) {
    logAutoCompaction(pending, "not-planned", { error: compactPlan.ok ? "not a compaction" : compactPlan.error });
    return { kind: "run", plan };
  }

  run.surface.delta({ type: "status", content: autoCompactStatus(decision) });
  const attempt = await runCompaction(run, compactPlan);
  if (attempt instanceof Error) {
    logAutoCompaction(pending, "failed", { error: attempt.message });
    await run.surface.notice(autoCompactFailedNotice(attempt.message, decision.trigger));
    return { kind: "run", plan };
  }

  const verdict = judge(run, attempt.result);
  logAutoCompaction(pending, verdict.outcome, attempt.result);
  if (verdict.outcome === "preempted") return { kind: "preempted" };
  if (verdict.outcome !== "compacted") {
    await run.surface.notice(autoCompactFailedNotice(verdict.reason, decision.trigger));
    return { kind: "run", plan };
  }
  const nativeId = recordCompaction(run, compactPlan, attempt, decision);
  await run.surface.notice(autoCompactDoneNotice(decision, attempt.result.compaction));
  return { kind: "run", plan: planAfterCompaction(plan, nativeId) };
}

/**
 * The turn was taken — by a stop, a workflow interruption, a newer message —
 * while it compacted, so its own prompt never reached the engine. Settled as
 * interrupted and silent upward, as any preempted turn is; a prompt a newer
 * message displaced is held for the next turn to carry, since the engine has no
 * record of it. The caller has confirmed the session can still take a result.
 */
export async function settlePreemptedBeforeEngine(run: TurnRun): Promise<void> {
  const sessionId = run.input.session.id;
  const superseded = isTurnSuperseded(sessionId, run.turnStartedAt);
  deletePartialMessages(sessionId);
  await settleTurn({
    sessionId,
    attemptToken: run.input.attemptToken,
    outcome: "interrupted",
    result: null,
    error: null,
    fields: run.terminalFields(),
    employee: run.input.employee,
    notifyParent: false,
    surface: run.surface,
  });
  if (superseded) retainUnseenInterruptedPrompt(sessionId, run.input.prompt);
  clearSupersededTurnMeta(sessionId);
  logger.info(`Session ${sessionId} interrupted before its engine run`);
}
