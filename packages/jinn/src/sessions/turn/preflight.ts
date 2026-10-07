import { buildPlatformContextRefresh, fingerprintPlatformContext } from "../../engines/platform-context.js";
import { isBudgetExhausted } from "../../gateway/budgets.js";
import { refuseScopedTurn } from "./scoped-turn.js";
import { isRemoteTarget } from "../../shared/remote-target.js";
import { refuseClaudeLogin } from "./claude-login-refusal.js";
import { resolveEffort } from "../../shared/effort.js";
import { isCompactCommand, isRawEngineCommand } from "../../shared/skill-commands.js";
import { opencodeMode } from "../../engines/opencode-server.js";
import { compactCommandRefusal } from "../compact-command.js";
import { logger } from "../../shared/logger.js";
import { effortLevelsForModel, engineAvailable, engineUnavailableMessage, isKnownEngine } from "../../shared/models.js";
import type { EngineSessionRef, ResolvedMcpConfig, Session } from "../../shared/types.js";
import { buildContext, buildPlatformContextSnapshot, runtimeSessionSource, type BuildContextOptions } from "../context.js";
import { resolveEngineRunMcp } from "../engine-run-mcp.js";
import { getEngineSessionRef, getMessages } from "../registry.js";
import { openTurnMessages } from "../queue-item-registry.js";
import { isRemoteMcpSession } from "../remote-mcp-session.js";
import { isTerminalSession, TERMINAL_REFUSES_MESSAGES } from "../../terminals/session.js";
import { readUnseenInterruptedPrompts } from "./superseded.js";
import type { TurnHierarchy, TurnInput, TurnPlan, TurnPreflight } from "./types.js";
export { warnIfNearUsageLimit } from "./usage-warning.js";

/** How many prior messages a synthesized engine-switch transcript carries. */
const SYNC_TRANSCRIPT_MESSAGES = 20;

/**
 * Marks a session whose conversation on this engine was found gone: its next
 * turn without a resume id starts a fresh one handed a transcript, and the
 * marker clears when such a turn settles cleanly.
 */
export const LOST_CONVERSATION_META_KEY = "lostConversationEngine";

/**
 * The lost-conversation transcript's budget. It travels in one command-line
 * argument, and a remote session's system prompt shares that argument
 * (argv-limit.ts), so it stays well short of the 128 KiB limit. Each message is
 * clipped first, so a single long one cannot crowd out the rest.
 */
const LOST_TRANSCRIPT_MAX_BYTES = 24_000;
const LOST_TRANSCRIPT_MESSAGE_MAX_BYTES = 4_000;

type EngineConfig = { bin?: string; model?: string; effortLevel?: string; childEffortOverride?: string };

/** Org hierarchy for the system prompt, or the reason this turn has none. */
export async function resolveTurnHierarchy(
  config: TurnInput["config"],
): Promise<TurnHierarchy> {
  try {
    const { readOrg } = await import("../../gateway/org-registry.js");
    const { resolveOrgHierarchy } = await import("../../gateway/org-hierarchy.js");
    const { registry, error } = readOrg(config);
    if (error) return { unavailable: error };
    return { hierarchy: resolveOrgHierarchy(registry) };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn(`Org hierarchy resolution failed — the turn will report it: ${reason}`);
    return { unavailable: reason };
  }
}

/**
 * The gates a turn must clear before an engine is worth spawning, in the order
 * that spends the least on a turn destined to fail: is the engine registered,
 * is its binary installed, is the employee still inside their budget. Returns
 * the error to settle as, or undefined when the turn may proceed.
 */
function refuseTurn(input: TurnInput): string | undefined {
  const session = input.session;
  // D3: a connector anchor is an identity, never an agent. Running one would be an employee-less engine turn — COO-shaped.
  if (isRemoteMcpSession(session)) return "A remote MCP connector session never runs an engine; its results are read back through the connector.";
  if (isTerminalSession(session)) return TERMINAL_REFUSES_MESSAGES;
  if (!input.engineOverride && !input.engines.has(session.engine)) {
    return `Engine "${session.engine}" not available`;
  }
  if (isKnownEngine(session.engine) && !engineAvailable(input.config, session.engine)) {
    return engineUnavailableMessage(input.config, session.engine);
  }
  if (session.employee && isBudgetExhausted(session.employee, input.config.budgets?.employees)) {
    return `Budget limit exceeded for employee "${session.employee}". Session blocked.`;
  }
  return refuseScopedOrLogin(input);
}

/** The department-scope gates (scoped-turn.ts), then the Claude login check. */
function refuseScopedOrLogin(input: TurnInput): string | undefined {
  return refuseScopedTurn(input.session, input.engineOverride?.name, isRemoteTarget(input.employee), input.config.engines.claude?.bin) ?? refuseClaudeLogin(input);
}

function resolveTurnEffort(input: TurnInput, engineConfig: EngineConfig): string | undefined {
  const session = input.session;
  return resolveEffort(
    engineConfig,
    session,
    input.employee,
    effortLevelsForModel(input.config, session.engine, session.model ?? undefined),
  );
}

/** What the system prompt is built from, minus the model each attempt picks. */
function contextOptionsFor(
  input: TurnInput,
  effortLevel: string | undefined,
  resolvedMcp: ResolvedMcpConfig | undefined,
  runtimeSource: string,
): Omit<BuildContextOptions, "model"> {
  return {
    source: runtimeSource,
    channel: input.channel,
    thread: input.thread,
    user: input.user,
    employee: input.employee,
    engine: input.session.engine,
    connectors: input.connectorNames,
    config: input.config,
    gatewayBootId: input.gatewayBootId,
    sessionId: input.session.id,
    effortLevel,
    channelName: input.channelName,
    hierarchy: input.roster?.hierarchy,
    rosterUnavailable: input.roster?.unavailable,
    // The diet keys off the built-in jinn server specifically — custom MCP
    // servers don't carry the company tools.
    jinnMcpAttached: Boolean(resolvedMcp?.mcpServers?.["jinn"]),
  };
}

/** Resolve everything `engine.run` needs, or the reason the turn cannot run. */
export function preflightTurn(input: TurnInput): TurnPreflight {
  const refusal = refuseTurn(input);
  if (refusal) return { ok: false, error: refusal };

  const session = input.session;
  const engineName = session.engine;
  const resumeRef = getEngineSessionRef(session, engineName);
  const compaction = isCompactCommand(input.prompt);
  // `/compact` never reaches an engine that cannot compact: sent as text it is
  // just a message the model answers. Declined, not failed — nothing went wrong.
  const compactRefusal = compaction
    ? compactCommandRefusal(engineName, opencodeMode(input.config.engines.opencode), Boolean(resumeRef.id))
    : undefined;
  if (compactRefusal) return { ok: false, error: compactRefusal, declined: true };
  const { mcpConfigPath, resolvedMcp } = resolveEngineRunMcp({
    config: input.config,
    employee: input.employee,
    engine: engineName,
    sessionId: session.id,
  });

  // Per-engine config keyed by engine name; unconfigured optional engines
  // resolve to {} so the engine falls back to dynamic bin/model resolution.
  const engineConfig = (input.config.engines as unknown as Record<string, EngineConfig | undefined>)[engineName] ?? {};
  const effortLevel = resolveTurnEffort(input, engineConfig);
  const runtimeSource = runtimeSessionSource(session.source);

  const baseContextOptions = contextOptionsFor(input, effortLevel, resolvedMcp, runtimeSource);
  const rawCommand = isRawEngineCommand(engineName, input.prompt);
  const turnPrompt = rawCommand ? verbatimTurnPrompt(input.prompt) : resolveTurnPrompt(session, engineName, input.prompt, Boolean(resumeRef.id));

  return {
    ok: true,
    engine: input.engineOverride ?? input.engines.get(engineName)!,
    engineName,
    engineConfig,
    effortLevel,
    model: session.model ?? engineConfig.model,
    resumeSessionId: resumeRef.id ?? undefined,
    resumeNativeId: resumeRef.id,
    mcpConfigPath,
    resolvedMcp,
    runtimeSource,
    ...turnPrompt,
    compaction,
    prepareContext: contextPreparer(baseContextOptions, resumeRef, rawCommand),
  };
}

/**
 * An engine-native command (/compact, /clear, …) goes to the engine exactly as
 * written. Anything folded in front of it — an engine-switch transcript, a
 * message an interrupt kept from the engine — turns it into text for the model
 * and the command never runs. Both stay owed: neither is marked delivered, so
 * the next ordinary turn carries them.
 */
function verbatimTurnPrompt(prompt: string): Pick<TurnPlan, "promptToRun" | "syncRequested" | "carriedInterruptedPrompts"> {
  return { promptToRun: prompt, syncRequested: false, carriedInterruptedPrompts: false };
}

/** The per-attempt context builder: system prompt, fingerprint, and the
 *  platform-context refresh a resumed thread is owed when its fingerprint moved. */
function contextPreparer(
  baseContextOptions: BuildContextOptions,
  resumeRef: EngineSessionRef,
  rawCommand: boolean,
): TurnPlan["prepareContext"] {
  return (modelForAttempt) => {
    const contextOptions: BuildContextOptions = { ...baseContextOptions, model: modelForAttempt };
    const snapshot = buildPlatformContextSnapshot(contextOptions);
    const fingerprint = fingerprintPlatformContext(snapshot);
    // An engine-native command (/compact, /clear, …) must reach the engine
    // exactly as written, so it cannot carry a refresh. Record the fingerprint
    // the thread already had rather than this one, so the refresh it did not
    // carry is still owed — and sent — on the next ordinary turn.
    if (rawCommand && resumeRef.id) {
      return { fingerprint: resumeRef.platformContextFingerprint ?? "", refresh: undefined, systemPrompt: buildContext(contextOptions) };
    }
    const refresh = resumeRef.id && resumeRef.platformContextFingerprint !== fingerprint
      ? buildPlatformContextRefresh(snapshot)
      : undefined;
    return { fingerprint, refresh, systemPrompt: buildContext(contextOptions) };
  };
}

/**
 * The prompt this turn actually sends, once the things a turn may owe the engine
 * are folded in: a transcript of a conversation the engine lost, or of what it
 * missed on another engine, and any message an interrupt kept from it. A sync
 * transcript is rebuilt from the message log, which already holds the
 * interrupted messages, so it delivers them on its own and the prefix would
 * only repeat them.
 */
export function resolveTurnPrompt(
  session: Session,
  engineName: string,
  prompt: string,
  resuming: boolean,
): Pick<TurnPlan, "promptToRun" | "syncRequested" | "carriedInterruptedPrompts"> {
  if (!resuming && session.transportMeta?.[LOST_CONVERSATION_META_KEY] === engineName) {
    return { ...resolveLostConversationPrompt(session, prompt), syncRequested: true };
  }
  const { promptToRun, syncRequested } = resolveSyncPrompt(session, engineName, prompt);
  const unseen = readUnseenInterruptedPrompts(session);
  return {
    promptToRun: syncRequested ? promptToRun : withInterruptedPrompts(promptToRun, unseen),
    syncRequested,
    carriedInterruptedPrompts: unseen.length > 0,
  };
}

/**
 * A newer message can cut a turn off before the engine ever read its prompt, so
 * that prompt is missing from the engine's transcript and only this turn can put
 * it back. It leads, oldest first, with the current message last.
 */
function withInterruptedPrompts(prompt: string, unseen: string[]): string {
  if (unseen.length === 0) return prompt;
  const intro = `You were interrupted before reading ${unseen.length === 1 ? "this message" : "these messages"}, so respond to ${unseen.length === 1 ? "it" : "them"} too, not only to the current one.`;
  const earlier = unseen.map((text) => `EARLIER MESSAGE:\n${text}`).join("\n\n");
  const current = prompt.trim() ? `CURRENT MESSAGE:\n${prompt}` : "";
  return [intro, earlier, current].filter(Boolean).join("\n\n");
}

/** The instant a pending engine-switch transcript should start from, if any. */
function syncSince(session: Session, engineName: string): { sinceMs: number; engineSwitch: boolean; accountSwap?: boolean } | undefined {
  const meta = (session.transportMeta || {}) as Record<string, unknown>;
  const switchTarget = typeof meta.engineSyncTarget === "string" ? meta.engineSyncTarget : null;
  const switchSinceMs = new Date(String(meta.engineSyncSince ?? "")).getTime();
  if (switchTarget === engineName && Number.isFinite(switchSinceMs)) {
    return { sinceMs: switchSinceMs, engineSwitch: true };
  }
  const claudeSinceMs = new Date(String(meta.claudeSyncSince ?? "")).getTime();
  if (engineName === "claude" && Number.isFinite(claudeSinceMs)) {
    return { sinceMs: claudeSinceMs, engineSwitch: false, ...(meta.claudeSyncAccount === true ? { accountSwap: true } : {}) };
  }
  return undefined;
}

/**
 * A session that switched engines mid-conversation resumes on the new engine
 * with no memory of what came before, so the prompt carries a transcript of the
 * turns since the switch. The markers driving this are cleared by the terminal
 * write once a synced turn settles cleanly.
 */
export function resolveSyncPrompt(
  session: Session,
  engineName: string,
  prompt: string,
): { promptToRun: string; syncRequested: boolean } {
  const sync = syncSince(session, engineName);
  if (!sync) return { promptToRun: prompt, syncRequested: false };

  const recentMessages = getMessages(session.id).filter((message) => message.timestamp >= sync.sinceMs);
  const transcript = recentMessages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .slice(-SYNC_TRANSCRIPT_MESSAGES)
    .join("\n\n");

  const latest = recentMessages.at(-1);
  const promptAlreadyInTranscript = latest?.content === prompt
    && (latest.role === "user" || latest.role === "assistant");
  const currentPrompt = promptAlreadyInTranscript || !prompt.trim() ? "" : `CURRENT MESSAGE:\n${prompt}`;

  const intro = sync.engineSwitch
    ? "We switched engines in this Jinn session. Sync your context with this transcript (most recent last), then respond to the current message."
    : sync.accountSwap
      ? "We temporarily ran this session on another Claude account due to a usage limit. Sync your context with this transcript (most recent last), then respond to the current message."
      : "We temporarily switched to GPT due to a Claude usage limit. Sync your context with this transcript (most recent last), then respond to the current message.";

  return {
    promptToRun: [intro, transcript, currentPrompt].filter(Boolean).join("\n\n"),
    syncRequested: true,
  };
}

/**
 * The prompt for a turn whose engine no longer has the conversation this
 * session was running, sent to a fresh one with no memory of the session. It
 * carries the session's recent messages, then any message an interrupt kept
 * from the lost conversation, then the current message.
 *
 * The transcript leaves out this turn's own message and anything queued behind
 * it, which gets its own turn: the messages the session's open queue items
 * carry, known by id where the queue links them, else by their text appearing
 * in a queued prompt (which frames another session's message around it).
 * Tool-call rows and live partial blocks are left out; messages from other
 * sessions are kept, in full, since an agent's briefs and verdicts arrive that
 * way.
 */
export function resolveLostConversationPrompt(
  session: Session,
  prompt: string,
): Pick<TurnPlan, "promptToRun" | "carriedInterruptedPrompts"> {
  const unseen = readUnseenInterruptedPrompts(session);
  const open = openTurnMessages(session.id);
  const pending = { messageIds: open.messageIds, prompts: [prompt, ...open.prompts] };
  const lines = transcriptLines(getMessages(session.id).filter((message) => !isOpenTurnMessage(message, pending)), unseen);
  const carriedInterruptedPrompts = unseen.length > 0;
  if (lines.length === 0) return { promptToRun: withInterruptedPrompts(prompt, unseen), carriedInterruptedPrompts };
  const intro = "The conversation this Jinn session was running could not be resumed, so this is a new one. "
    + "Sync your context with this transcript of the session (most recent last), then respond to the current message.";
  const current = carriedInterruptedPrompts ? withInterruptedPrompts(prompt, unseen) : prompt.trim() ? `CURRENT MESSAGE:\n${prompt}` : "";
  return { promptToRun: [intro, lines.join("\n\n"), current].filter(Boolean).join("\n\n"), carriedInterruptedPrompts };
}

type LoggedMessage = ReturnType<typeof getMessages>[number];

/** A logged message as the engine would have read it: a notification's full text, not its banner. */
function engineText(message: LoggedMessage): string {
  const full = message.meta?.["fullMessage"];
  return typeof full === "string" && full.trim() ? full : message.content;
}

/** Whether a logged message is one an open turn (this one, or one queued) will answer. */
function isOpenTurnMessage(message: LoggedMessage, open: { messageIds: Set<string>; prompts: string[] }): boolean {
  if (open.messageIds.has(message.id)) return true;
  if (open.prompts.includes(message.content)) return true;
  if (message.role !== "notification") return false;
  const text = engineText(message);
  return open.prompts.some((prompt) => prompt === text || `\n${prompt}\n`.includes(`\n${text}\n`));
}

/** The newest transcript lines, oldest first, within budget. */
function transcriptLines(messages: LoggedMessage[], unseen: string[]): string[] {
  const lines: string[] = [];
  let bytes = 0;
  for (let i = messages.length - 1; i >= 0 && lines.length < SYNC_TRANSCRIPT_MESSAGES; i--) {
    const line = transcriptLine(messages[i]!, unseen);
    if (!line) continue;
    const size = Buffer.byteLength(line) + 2;
    if (bytes + size > LOST_TRANSCRIPT_MAX_BYTES) break;
    bytes += size;
    lines.unshift(line);
  }
  return lines;
}

/** One message as a transcript line, or nothing for a row the transcript leaves out. */
function transcriptLine(message: LoggedMessage, unseen: string[]): string | undefined {
  if (message.partial || message.toolCall) return undefined;
  const label = TRANSCRIPT_LABELS.get(message.role);
  const text = engineText(message);
  // A held interrupted prompt is asked for after the transcript instead.
  if (!label || (message.role === "user" && unseen.includes(text))) return undefined;
  return `${label}: ${clipToBytes(text, LOST_TRANSCRIPT_MESSAGE_MAX_BYTES)}`;
}

const TRANSCRIPT_LABELS = new Map([
  ["user", "USER"],
  ["assistant", "ASSISTANT"],
  ["notification", "MESSAGE FROM ANOTHER SESSION"],
]);

/** `text` cut to at most `max` UTF-8 bytes, marked where it was cut. */
function clipToBytes(text: string, max: number): string {
  if (Buffer.byteLength(text) <= max) return text;
  const marker = " […clipped]";
  let clipped = Buffer.from(text).subarray(0, max - Buffer.byteLength(marker)).toString("utf8");
  // A cut through a multi-byte character decodes to U+FFFD; drop it.
  clipped = clipped.replace(/\uFFFD$/, "");
  return `${clipped}${marker}`;
}

/** Strip the sync markers a settled synced turn consumed; `keepLostConversation` leaves a lost conversation's owed. */
export function withSyncMarkersCleared(meta: unknown, opts: { keepLostConversation?: boolean } = {}): Record<string, unknown> {
  const base = meta && typeof meta === "object" && !Array.isArray(meta) ? { ...(meta as Record<string, unknown>) } : {};
  delete base["claudeSyncSince"];
  delete base["claudeSyncAccount"];
  delete base["engineSyncTarget"];
  delete base["engineSyncSince"];
  if (!opts.keepLostConversation) delete base[LOST_CONVERSATION_META_KEY];
  return base;
}
