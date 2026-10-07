import { logger } from "../../shared/logger.js";
import { markTranscriptSyncedThrough } from "../../gateway/external-turns.js";
import {
  clearEngineSessionRefs,
  deletePartialMessages,
  getSession,
  insertMessage,
  insertMessageAfter,
  updateSession,
  type UpdateSessionFields,
} from "../registry.js";
import { isRemoteMcpSession } from "../remote-mcp-session.js";
import { settleTurn, type SettleTurnInput } from "./completion.js";
import type { EngineAttempt } from "./engine-run.js";
import { LOST_CONVERSATION_META_KEY, withSyncMarkersCleared } from "./preflight.js";
import {
  clearSupersededTurnMeta,
  retainUnseenInterruptedPrompt,
  withUnseenInterruptedPromptsCleared,
} from "./superseded.js";
import { formatResumeTime, shouldPersistFinalAssistantMessage, turnDisplayText } from "./text.js";
import { COMPACTION_UNCONFIRMED, compactionConfirmation, compactionRateLimited, unusedFocusNote } from "../compact-command.js";
import { rateLimitEngineLabel } from "../../shared/rateLimit.js";
import { rateLimitAccount, recordAccountRateLimit } from "../rate-limit-account.js";
import type { EngineResult } from "../../shared/types.js";
import type { TurnInput, TurnRun, TurnSurface } from "./types.js";

/**
 * A turn on a remote MCP connector anchor, which preflight refuses (D3). The
 * anchor is an inbox, never an agent: the message that queued this turn is
 * already recorded in its transcript, which is where the connector reads it
 * back, so nothing failed. Settling it `failed` would park the anchor in
 * `error`, and callbacks skip an errored parent, so every later child
 * completion addressed to it would be dropped.
 */
async function settleAnchorTurn(
  input: TurnInput,
  surface: TurnSurface,
  terminalFields: () => UpdateSessionFields,
): Promise<void> {
  await settleTurn({
    sessionId: input.session.id,
    attemptToken: input.attemptToken,
    outcome: "succeeded",
    fields: terminalFields(),
    employee: input.employee,
    expectedStatuses: ["running", "waiting"],
    surface,
  });
}

/** Preflight refused: record the reason everywhere the turn would have landed. */
export async function settleRefusedTurn(
  input: TurnInput,
  surface: TurnSurface,
  error: string,
  terminalFields: () => UpdateSessionFields,
): Promise<void> {
  if (isRemoteMcpSession(input.session)) return settleAnchorTurn(input, surface, terminalFields);
  logger.error(`Session ${input.session.id} blocked: ${error}`);
  insertMessage(input.session.id, "assistant", `⛔ ${error}`);
  await settleTurn({
    sessionId: input.session.id,
    attemptToken: input.attemptToken,
    outcome: "failed",
    error,
    fields: terminalFields(),
    employee: input.employee,
    // `waiting` alongside the default `running`, for the same reason the
    // rate-limit path widens it: the remote-host gate moves the session to
    // `waiting` while a desktop boots, and a refusal out of that state has to
    // land. Without it the fenced write is rejected, settleTurn returns before
    // notifying the parent and the transport, and the session is pinned at
    // `waiting` forever — the silent stall this feature is built to avoid.
    expectedStatuses: ["running", "waiting"],
    surface,
  });
  await surface.reply(`⛔ ${error}`);
}

/**
 * Preflight answered the turn itself (an operator `/compact` this session's
 * engine cannot run): say why, and settle as succeeded. Not `failed` — that
 * would park the session in `error` and report a failure to its parent for a
 * command that did exactly what it should. Nothing reached an engine, so there
 * is nothing to report upward at all.
 */
export async function settleDeclinedTurn(
  input: TurnInput,
  surface: TurnSurface,
  reason: string,
  terminalFields: () => UpdateSessionFields,
): Promise<void> {
  logger.info(`Session ${input.session.id} declined: ${reason}`);
  await surface.notice(reason);
  await settleTurn({
    sessionId: input.session.id,
    attemptToken: input.attemptToken,
    outcome: "succeeded",
    fields: terminalFields(),
    employee: input.employee,
    expectedStatuses: ["running", "waiting"],
    notifyParent: false,
    surface,
  });
}

/**
 * A `/compact` whose engine answered with a usage limit. It is settled here, on
 * its own engine, instead of entering the rate-limit branch: that branch would
 * re-run the prompt on a fallback engine (as text, or against a different
 * conversation) or park the session until the limit lifts. Nothing was
 * compacted, so the operator is told so and can send it again.
 */
export async function settleRateLimitedCompaction(run: TurnRun, resetsAtSeconds: number | undefined): Promise<void> {
  const sessionId = run.input.session.id;
  const resumeAt = typeof resetsAtSeconds === "number" ? new Date(resetsAtSeconds * 1000) : null;
  const engineLabel = rateLimitEngineLabel(run.plan.engineName);
  const text = compactionRateLimited(engineLabel, formatResumeTime(resumeAt));
  logger.info(`Session ${sessionId}: /compact hit a usage limit; not retried or moved to another engine`);
  // Recorded as the rate-limit branch records it, so the next turn — here or
  // in any session — knows the limit without spending a spawn to find it.
  const { account } = rateLimitAccount(run.plan.engineName, run.input.employee, run.input.session);
  recordAccountRateLimit(account, run.plan.engineName, engineLabel, resetsAtSeconds);
  await run.surface.notice(text);
  await settleTurn({
    sessionId,
    attemptToken: run.input.attemptToken,
    outcome: "succeeded",
    fields: run.terminalFields(),
    employee: run.input.employee,
    notifyParent: false,
    surface: run.surface,
  });
}

/** What the runner observed about how this turn ended, beyond its result. */
export interface TurnVerdict {
  quietPreempted: boolean;
  streamedThrough: number;
  /** A newer user message displaced this turn. */
  superseded: boolean;
  /** The engine got far enough to have this turn's prompt in its own transcript. */
  enginePromptRead: boolean;
}

/** Settle a turn that reached the engine, whether or not its answer is wanted. */
export async function settleAnsweredTurn(
  run: TurnRun,
  attempt: EngineAttempt,
  model: string | undefined,
  verdict: TurnVerdict,
): Promise<void> {
  const sessionId = run.input.session.id;
  const { engineName } = run.plan;
  const result = attempt.result;
  const { quietPreempted } = verdict;

  const displayText = quietPreempted ? "" : turnDisplayText(result.result, result.error);
  if (shouldPersistFinalAssistantMessage({ resultText: result.result, quietPreempted }) || displayText) {
    insertMessageAfter(sessionId, "assistant", displayText, verdict.streamedThrough, undefined, undefined, answeredMessageMeta(run, attempt));
  }
  if (!quietPreempted) await announceCompaction(run, result);

  const settled = await settleTurn({
    ...answeredReceipt(run, attempt, model, verdict),
    surface: run.surface,
  });

  holdPromptTheEngineNeverRead(run, verdict);
  if (!quietPreempted && engineName === "claude") markTranscriptSyncedThrough(sessionId, result.sessionId);
  clearSupersededTurnMeta(sessionId);
  if (settled && displayText) await run.surface.reply(displayText);

  logSettledTurn(sessionId, result, quietPreempted);
}

/**
 * A compaction answers nothing, so the chat would show no sign it happened.
 * A notice, not the result: the result is what a parent session is told. Only
 * an engine that reported compacting gets the confirmation; a failed one has
 * its error for an answer already.
 */
async function announceCompaction(run: TurnRun, result: EngineResult): Promise<void> {
  if (!run.plan.compaction || result.error) return;
  if (!result.compaction) return await run.surface.notice(COMPACTION_UNCONFIRMED);
  const note = unusedFocusNote(run.plan.engineName, run.input.prompt);
  await run.surface.notice([compactionConfirmation(result.compaction), note].filter(Boolean).join(" "));
}

/** The receipt already records a failed turn as `failed`; the log line has to
 *  agree, or an outage reads as a run of completions to anyone grepping it. */
function logSettledTurn(sessionId: string, result: EngineResult, quietPreempted: boolean): void {
  const timing = (result.durationMs ? ` in ${result.durationMs}ms` : "") + (result.cost ? ` ($${result.cost.toFixed(4)})` : "");
  if (quietPreempted) logger.info(`Session ${sessionId} interrupted${timing}${result.error?.startsWith("Interrupted") ? `: ${result.error}` : ""}`);
  else if (result.error) logger.error(`Session ${sessionId} failed${timing}: ${result.error}`);
  else logger.info(`Session ${sessionId} completed${timing}`);
}

function answeredMessageMeta(run: TurnRun, attempt: EngineAttempt) {
  return {
    assistantPhase: "final",
    turnStartedAt: run.turnStartedAt,
    turnOutcome: attempt.result.error ? "error" : "complete",
  };
}

/**
 * A newer message can cut a turn off before the engine reads its prompt, which
 * leaves the engine with no record of it at all. Hold it for the next turn to
 * carry, or it is lost from the conversation the engine sees.
 */
function holdPromptTheEngineNeverRead(run: TurnRun, verdict: TurnVerdict): void {
  if (!verdict.superseded || verdict.enginePromptRead) return;
  retainUnseenInterruptedPrompt(run.input.session.id, run.input.prompt);
}

/** The engine's own account of an interruption, for the session's last error.
 *  A turn preempted with no such account keeps the bare placeholder. */
function interruptionOf(result: EngineResult, quietPreempted: boolean): { interruption?: string } {
  return quietPreempted && result.error?.startsWith("Interrupted") ? { interruption: result.error } : {};
}

/** The receipt a turn that reached the engine writes, preempted or not. */
function answeredReceipt(
  run: TurnRun,
  attempt: EngineAttempt,
  model: string | undefined,
  verdict: TurnVerdict,
): Omit<SettleTurnInput, "surface"> {
  const { quietPreempted } = verdict;
  const result = attempt.result;
  // A turn that failed on its own files nothing. A preempted one still files,
  // because it may have minted the thread the interrupted message now lives in.
  const filesEngineSession = quietPreempted || !result.error;
  return {
    sessionId: run.input.session.id,
    attemptToken: run.input.attemptToken,
    outcome: quietPreempted ? "interrupted" : (result.error ? "failed" : "succeeded"),
    result: quietPreempted ? null : result.result,
    error: quietPreempted ? null : (result.error ?? null),
    ...interruptionOf(result, quietPreempted),
    cost: result.cost,
    durationMs: result.durationMs,
    accounting: { cost: result.cost, numTurns: result.numTurns, ...(model ? { model } : {}) },
    ...(filesEngineSession ? filedEngineSession(run, attempt, model, quietPreempted) : {}),
    fields: buildTerminalFields(run, meteredContextTokens(run, result), verdict, Boolean(result.error)),
    employee: run.input.employee,
    // An interrupted turn stays silent upward: whoever interrupted it reports.
    notifyParent: !quietPreempted,
  };
}

/**
 * The engine session this turn files for the next resume, if any.
 *
 * A turn that answered files the thread it used, falling back to the one it
 * resumed from so a turn that answered without echoing its own session id does
 * not orphan the engine session it actually used.
 *
 * A turn a newer message cut off files only a thread it MINTED. That thread
 * holds whatever the engine recorded of the interrupted message, and nothing
 * else will ever resume it — on a fresh session that is the whole of message
 * one. The id it merely resumed from is already the successor's, and rewriting
 * it here would stamp this turn's context fingerprint onto a refresh the engine
 * never finished consuming.
 */
function filedEngineSession(
  run: TurnRun,
  attempt: EngineAttempt,
  model: string | undefined,
  quietPreempted: boolean,
): Pick<SettleTurnInput, "engineSession"> {
  const echoed = attempt.result.sessionId?.trim();
  const nativeId = quietPreempted
    ? (echoed === run.plan.resumeNativeId ? undefined : echoed)
    : (echoed || run.plan.resumeNativeId);
  if (!nativeId) return {};
  return {
    engineSession: {
      engine: run.plan.engineName,
      nativeId,
      meta: { model, effortLevel: run.plan.effortLevel, platformContextFingerprint: attempt.fingerprint },
    },
  };
}

/** The turn threw: settle it as failed. The caller has confirmed it can land. */
export async function settleThrownTurn(run: TurnRun, errMsg: string): Promise<void> {
  const sessionId = run.input.session.id;
  deletePartialMessages(sessionId);
  await settleTurn({
    sessionId,
    attemptToken: run.input.attemptToken,
    outcome: "failed",
    error: errMsg,
    fields: run.terminalFields(),
    employee: run.input.employee,
    surface: run.surface,
  });
  await run.surface.reply(`Error: ${errMsg}`);
}

/**
 * What the context meter should read after this turn: the engine's count, or,
 * for a compaction confirmed without a size after it, nothing at all — the
 * last reading is the pre-compaction size (streamed while the summary ran), and
 * leaving it would show the context as full straight after emptying it. The
 * next turn's reading fills it in. Undefined leaves the meter as it is.
 */
function meteredContextTokens(run: TurnRun, result: EngineResult): number | null | undefined {
  if (typeof result.contextTokens === "number") return result.contextTokens;
  if (run.plan.compaction && result.compaction && !result.error) return null;
  return undefined;
}

function buildTerminalFields(run: TurnRun, contextTokens: number | null | undefined, verdict: TurnVerdict, failed: boolean): UpdateSessionFields {
  const fields: UpdateSessionFields = { ...run.terminalFields() };
  if (contextTokens !== undefined) fields.lastContextTokens = contextTokens;
  const clearSyncMarkers = run.plan.syncRequested && !verdict.quietPreempted;
  // The held prompts this turn put in front of the engine are owed no longer,
  // and only the engine having read them settles that.
  const clearCarriedPrompts = run.plan.carriedInterruptedPrompts && verdict.enginePromptRead;
  if (clearSyncMarkers || clearCarriedPrompts) {
    let meta: unknown = fields.transportMeta ?? getSession(run.input.session.id)?.transportMeta;
    // A lost conversation's transcript is owed until a turn carrying it
    // actually ran: a failed one leaves it for the next.
    if (clearSyncMarkers) meta = withSyncMarkersCleared(meta, { keepLostConversation: failed });
    if (clearCarriedPrompts) meta = withUnseenInterruptedPromptsCleared(meta);
    fields.transportMeta = meta as UpdateSessionFields["transportMeta"];
  }
  return fields;
}

/**
 * A stale engine-session id makes every resume fail. Drop this engine's typed ref
 * so the next attempt starts a fresh engine session instead of retrying a dead one,
 * and drop any rate-limit override that would otherwise restore the dead id.
 */
export function clearDeadEngineSession(sessionId: string, engineName: string): void {
  logger.warn(`Dead session detected for ${sessionId} — clearing stale engine IDs`);
  const meta = { ...(getSession(sessionId)?.transportMeta || {}) } as Record<string, unknown>;
  delete meta["engineOverride"];
  // Whatever runs next on this engine starts a fresh conversation; this has it
  // handed the session so far rather than nothing.
  meta[LOST_CONVERSATION_META_KEY] = engineName;
  clearEngineSessionRefs(sessionId, engineName);
  updateSession(sessionId, { transportMeta: meta as UpdateSessionFields["transportMeta"] });
}
