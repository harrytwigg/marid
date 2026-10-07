import { logger } from "../../shared/logger.js";
import { detectRateLimit, isDeadSessionError, type RateLimitDetection } from "../../shared/rateLimit.js";
import { observeClaudeTurnOutcome } from "../claude-auth-watch.js";
import type { EngineResult, Session } from "../../shared/types.js";
import { completedStreamedBlockIds } from "../../gateway/streamed-blocks.js";
import {
  deletePartialMessages,
  getPartialMessages,
  getSession,
  settlePartialMessages,
  updateSession,
  type UpdateSessionFields,
} from "../registry.js";
import { createPartialStreamWriter } from "../partial-stream.js";
import { runEngineAttempt, resolveModelFallback, type EngineAttempt } from "./engine-run.js";
import { compactColdSessionFirst, settlePreemptedBeforeEngine } from "./auto-compact.js";
import { armTurnHeartbeat } from "./heartbeat.js";
import { preflightTurn, resolveTurnPrompt, warnIfNearUsageLimit } from "./preflight.js";
import { isMissingConversationOutput, isProcessStartFailure } from "../../shared/process-start.js";
import { isRawEngineCommand } from "../../shared/skill-commands.js";
import { ensureRemoteHostReady } from "./remote-ready.js";
import { runRateLimitTurn } from "./rate-limit-turn.js";
import {
  clearDeadEngineSession,
  settleAnsweredTurn,
  settleDeclinedTurn,
  settleRateLimitedCompaction,
  settleRefusedTurn,
  settleThrownTurn,
} from "./settle.js";
import { COMPACT_STARTED_STATUS } from "../compact-command.js";
import { clearSupersededTurnMeta, isTurnSuperseded } from "./superseded.js";
import type { TurnInput, TurnRun, TurnSurface } from "./types.js";

/**
 * Run one turn, from preflight to terminal receipt, for every transport.
 *
 * The caller has already begun the attempt and owns the queue slot; this owns
 * everything between. Both the connector runner and the web runner call it, and
 * the only thing they supply differently is the `TurnSurface`.
 */
export async function runTurn(input: TurnInput, surface: TurnSurface): Promise<void> {
  let turn: TurnInput | undefined = input;
  while (turn) turn = await runTurnOnce(turn, surface);
}

/**
 * One pass of a turn. Returns the input to run it again with when a rate-limit
 * wait on a substitute Claude account handed the session back to its own
 * account: the same turn, under the same attempt, from preflight onwards, so it
 * resumes that account's thread with the sync transcript it is owed.
 */
async function runTurnOnce(input: TurnInput, surface: TurnSurface): Promise<TurnInput | undefined> {
  const sessionId = input.session.id;
  const terminalFields = (): UpdateSessionFields => input.terminalFields?.() ?? {};

  const plan = preflightTurn(input);
  if (!plan.ok) {
    if (plan.declined) await settleDeclinedTurn(input, surface, plan.error, terminalFields);
    else await settleRefusedTurn(input, surface, plan.error, terminalFields);
    return undefined;
  }

  // A remote employee's host may be asleep. Wake it and wait for it BEFORE the
  // turn is announced as started, so the session reads as `waiting` rather than
  // `running` against a machine that is still booting. No-op for local employees.
  const remoteReady = await ensureRemoteHostReady(input, plan.engineName);
  if (!remoteReady.ok) {
    await settleRefusedTurn(input, surface, remoteReady.error, terminalFields);
    return undefined;
  }

  logger.info(`Session ${sessionId} running engine "${plan.engineName}" (model: ${plan.model || "default"})`);
  await surface.started();
  // A compaction streams nothing the chat shows, so say what is happening.
  if (plan.compaction) surface.delta({ type: "status", content: COMPACT_STARTED_STATUS });
  await warnIfNearUsageLimit(input, plan, surface);

  const run: TurnRun = {
    input,
    plan,
    surface,
    heartbeat: armTurnHeartbeat(sessionId, input.attemptToken),
    partialStream: createPartialStreamWriter(sessionId),
    turnStartedAt: Date.now(),
    terminalFields,
  };

  return await runPlannedTurn(run);
}

/** From the engine run to the terminal receipt, or to the hand-back's re-run. */
async function runPlannedTurn(run: TurnRun): Promise<TurnInput | undefined> {
  try {
    if (!await compactFirstIfCold(run)) return undefined;
    const { attempt, model } = await runEngineOrStartAfresh(run);
    run.heartbeat.stop();
    const handedBack = await concludeTurn(run, attempt, model);
    return handedBack ? { ...run.input, session: handedBack } : undefined;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error(`Session ${run.input.session.id} error: ${errMsg}`);
    if (claimSettleableSession(run, "error")) await settleThrownTurn(run, errMsg);
    return undefined;
  } finally {
    run.heartbeat.stop();
  }
}

/**
 * Auto-compaction: a long session whose prompt cache has gone cold is compacted first,
 * inside this turn and its queue slot (a no-op unless configured). False when
 * the turn was preempted meanwhile and has been settled as such.
 */
async function compactFirstIfCold(run: TurnRun): Promise<boolean> {
  const precompaction = await compactColdSessionFirst(run);
  if (precompaction.kind === "run") {
    run.plan = precompaction.plan;
    return true;
  }
  run.heartbeat.stop();
  if (claimSettleableSession(run, "result")) await settlePreemptedBeforeEngine(run);
  return false;
}

/**
 * Run the engine; if the CLI says the conversation it was asked to resume no
 * longer exists, run the turn once more in a fresh conversation that is handed
 * the session's recent messages. Without this the turn fails at birth, the
 * message it carried is never answered, and the session sits in `error` until
 * someone sends it something else. If the second run fails too, the transcript
 * stays owed to the session's next turn.
 */
async function runEngineOrStartAfresh(run: TurnRun): Promise<{ attempt: EngineAttempt; model: string | undefined }> {
  const first = await runEngineWithModelFallback(run);
  if (!lostResumedConversation(run, first.attempt.result)) return first;

  const sessionId = run.input.session.id;
  const lostId = run.plan.resumeSessionId;
  logger.warn(`Session ${sessionId}: ${run.plan.engineName} has no conversation ${lostId} to resume; starting a fresh one with the session's recent messages`);
  clearDeadEngineSession(sessionId, run.plan.engineName);
  deletePartialMessages(sessionId);
  updateSession(sessionId, { lastError: null });
  run.plan = {
    ...run.plan,
    resumeSessionId: undefined,
    resumeNativeId: undefined,
    // clearDeadEngineSession marked the conversation lost, so this is the
    // lost-conversation prompt, owed until a turn settles cleanly with it.
    ...resolveTurnPrompt(getSession(sessionId) ?? run.input.session, run.plan.engineName, run.input.prompt, false),
  };
  return await runEngineWithModelFallback(run);
}

/**
 * Whether this attempt's process never started because the CLI no longer has
 * the conversation the turn resumed, with the turn still this attempt's to run.
 * An engine-native command (`/compact` and the like) is not re-run: in a new,
 * empty conversation it has nothing to act on.
 */
function lostResumedConversation(run: TurnRun, result: EngineResult): boolean {
  const { plan, input } = run;
  if (!plan.resumeSessionId || !result.error || plan.compaction || isRawEngineCommand(plan.engineName, input.prompt)) return false;
  if (!isProcessStartFailure(result.error) || !isMissingConversationOutput(result.error, plan.resumeSessionId)) return false;
  const live = getSession(input.session.id);
  return live?.attemptToken === input.attemptToken && live.status === "running" && live.engine === plan.engineName;
}

/** Run the engine, retrying once on a model Claude has since withdrawn. */
async function runEngineWithModelFallback(run: TurnRun): Promise<{ attempt: EngineAttempt; model: string | undefined }> {
  let model = run.plan.model;
  let attempt = await runEngineAttempt({ ...run, model });

  const retryModel = await resolveModelFallback(run.input, run.plan, attempt.result, model);
  if (retryModel) {
    deletePartialMessages(run.input.session.id);
    model = retryModel;
    updateSession(run.input.session.id, { model: retryModel, lastError: null });
    attempt = await runEngineAttempt({ ...run, model });
  }
  return { attempt, model };
}

/**
 * The session this turn belongs to, or undefined when the result no longer has
 * anywhere to land: the session was deleted, or it has since switched engines
 * and this answer came from the old one.
 */
function claimSettleableSession(run: TurnRun, what: "result" | "error"): Session | undefined {
  const sessionId = run.input.session.id;
  const live = getSession(sessionId);
  if (!live) {
    deletePartialMessages(sessionId);
    logger.warn(`Dropping engine ${what} for deleted session ${sessionId}`);
    return undefined;
  }
  if (live.engine !== run.plan.engineName) {
    deletePartialMessages(sessionId);
    clearSupersededTurnMeta(sessionId);
    logger.info(`Dropping stale ${run.plan.engineName} ${what} for session ${sessionId}; session now uses ${live.engine}`);
    return undefined;
  }
  return live;
}

/**
 * Was this turn's answer preempted before it could land? A newer user message,
 * a stop, or another turn taking the attempt all mean
 * the same thing: settle as interrupted and say nothing to anyone.
 */
function wasQuietlyPreempted(run: TurnRun, live: Session, result: EngineResult, superseded: boolean): boolean {
  if (result.error?.startsWith("Interrupted")) return true;
  if (live.attemptToken !== run.input.attemptToken || live.status !== "running") return true;
  return superseded;
}

/**
 * What this turn said about the login it ran under, so the second auth failure
 * of an outage is counted and the first is alerted. A preempted, dead-session
 * or rate-limited turn says nothing either way.
 */
function noteClaudeLogin(run: TurnRun, result: EngineResult, silent: boolean): void {
  if (run.plan.engineName !== "claude" || silent) return;
  // A clean turn that produced nothing and cost nothing (a native `/command`)
  // never reached the API, so it is no evidence the login works.
  if (!result.error && !result.result?.trim() && !result.cost) return;
  observeClaudeTurnOutcome(run.input.employee, result.error, new Date(), run.input.session);
}

/**
 * A turn its engine refused with a usage limit: wait and retry, or switch to a
 * fallback engine. Not a compaction, though — a substitute would get "/compact"
 * as text to answer, or compact a different conversation — which is settled
 * where it is, for the operator to send again once the limit lifts.
 */
async function settleLimitedTurn(
  run: TurnRun,
  attempt: EngineAttempt,
  rateLimit: RateLimitDetection,
): Promise<Session | undefined> {
  if (run.plan.compaction) {
    await settleRateLimitedCompaction(run, rateLimit.resetsAt);
    return undefined;
  }
  return await runRateLimitTurn({
    input: run.input,
    plan: run.plan,
    surface: run.surface,
    systemPrompt: attempt.systemPrompt,
    platformContextRefresh: attempt.contextRefresh,
    platformContextFingerprint: attempt.fingerprint,
    rateLimit,
    originalResult: attempt.result,
    terminalFields: run.terminalFields,
  });
}

/** Settle whichever terminal class this turn landed in, or return the session
 *  a rate-limit hand-back left it to be re-run on. */
async function concludeTurn(run: TurnRun, attempt: EngineAttempt, model: string | undefined): Promise<Session | undefined> {
  const sessionId = run.input.session.id;
  const live = claimSettleableSession(run, "result");
  if (!live) return undefined;

  const result = attempt.result;
  const superseded = isTurnSuperseded(sessionId, run.turnStartedAt);
  const quietPreempted = wasQuietlyPreempted(run, live, result, superseded);

  // A stale engine-session id can carry text like "429" that would otherwise
  // read as a rate limit, so dead sessions are cleared before that check.
  const dead = !quietPreempted && isDeadSessionError(result);
  if (dead) clearDeadEngineSession(sessionId, run.plan.engineName);
  const rateLimit = !quietPreempted && !dead ? detectRateLimit(result) : { limited: false as const };
  noteClaudeLogin(run, result, quietPreempted || dead || rateLimit.limited);

  // Keep the same completed evidence the live view kept — interim prose, tools,
  // media, delegation blocks — and drop exact streamed copies of the result,
  // which the canonical final row replaces.
  const streamedBlocks = getPartialMessages(sessionId);
  settlePartialMessages(sessionId, completedStreamedBlockIds({
    quietPreempted,
    rateLimited: rateLimit.limited,
    result: result.result,
    error: result.error,
    streamedBlocks,
  }));

  if (rateLimit.limited) return await settleLimitedTurn(run, attempt, rateLimit);

  const streamedThrough = streamedBlocks.reduce((latest, message) => Math.max(latest, message.timestamp), 0);
  // A turn killed before it emitted anything is one the engine never began, so
  // its prompt is absent from the engine's own transcript. Anything it did emit
  // proves the engine read the prompt and recorded it.
  const enginePromptRead = !quietPreempted || streamedBlocks.length > 0;
  await settleAnsweredTurn(run, attempt, model, { quietPreempted, streamedThrough, superseded, enginePromptRead });
  return undefined;
}
