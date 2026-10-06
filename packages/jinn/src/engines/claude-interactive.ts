import fs from "node:fs";
import * as pty from "node-pty";
import type { CompactionStats, InterruptibleEngine, EngineRunOpts, EngineResult, EngineRateLimitInfo, StreamDelta, TurnProgress } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { JINN_HOME, CLAUDE_SETTINGS_DIR } from "../shared/paths.js";
import { cleanupSessionSettings } from "../shared/claude-settings.js";
import { ensureClaudeProfileTrust, writeClaudeSessionSettings } from "./claude-profile-launch.js";
import type { ClaudeProfile } from "../shared/claude-profile.js";
import { resolveBin } from "../shared/resolve-bin.js";
import { buildEngineChildEnv } from "../shared/child-env.js";
import { PtyLifecycleManager, isProcessExitInterruption, processExitInterruption, type PtyExit, type PtyHandle } from "./pty-lifecycle.js";
import { processStartFailure } from "../shared/process-start.js";
import { argumentLimitApplies, assertArgumentsFit } from "./argv-limit.js";
import { PtyStreamManager, createPtyHandle, setCapped } from "./pty-stream.js";
import type { PtyControlEvent, PtyViewEngine, PtyIdleSpawnOpts, PtySnapshotSubscription } from "./pty-view-engine.js";
import type { HookRegistry, HookPayload } from "../gateway/hook-registry.js";
import { SsePtyProxy, MAIN_AGENT_SENTINEL, type SseDataEvent, type UpstreamActivityInfo } from "./sse-pty-proxy.js";
import { finishedTaskNotificationIds } from "./task-notifications.js";
import { isCompactCommand, isNativeClaudeCommand, neutralizeForPaste } from "../shared/skill-commands.js";
import { buildPromptWithPlatformContext } from "./platform-context.js";
import { findSessionTranscript } from "./claude-transcript-path.js";
import { extractActivityReceiptId } from "../shared/activity-receipts.js";
import { costOfUsage } from "../shared/model-pricing.js";
import { claudeResetsAtSeconds } from "../shared/engine-reset-times.js";
import { writeMcpConfigFile } from "../mcp/resolver.js";
import { parsePermissionPrompt, chooseApproval, keystrokesToSelect } from "./claude-permission-prompt.js";
import { USER_MESSAGE_INTERRUPTION_REASON, USER_STOP_INTERRUPTION_REASON } from "../sessions/interruption-reasons.js";
import { assertRemoteTarget, isRemoteTarget, resolveRemoteClaudeConfigDir, sshDestination } from "../shared/remote-target.js";
import { mapAttachmentsForRemote, withRemoteAttachments } from "../shared/remote-attachments.js";
import type { RemoteTarget, ResolvedMcpConfig } from "../shared/types.js";
import type { RemoteExecutionConfig } from "../shared/config-types.js";
import {
  buildSshSpawnArgs,
  remoteSessionBinDir,
  cachedRemoteFacts,
  ensureRemoteReady,
  remoteNodeDir,
  remoteSessionHome,
  prepareRemoteSession,
  requireRemoteEngineBin,
  type RemoteFacts,
  type RemoteClaudeStaging,
} from "./remote-stage.js";

export type { PtyControlEvent } from "./pty-view-engine.js";

interface InteractiveArgsOpts {
  prompt: string;
  settingsPath: string;
  resumeSessionId?: string;
  model?: string;
  effortLevel?: string;
  mcpConfigPath?: string;
  cliFlags?: string[];
  attachments?: string[];
  /** Gateway system prompt (persona/org context) + main-agent sentinel, passed via
   *  the CLI `--append-system-prompt` flag. The settings-file `appendSystemPrompt`
   *  KEY is ignored by claude CLI ≥2.1.x, so this flag is the only path that
   *  actually lands it in the request `system` (and thus lets the SSE proxy tee). */
  appendSystemPrompt?: string;
}

interface TranscriptUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  assistantTurns: number;
}

/**
 * Sum assistant-message usage from a Claude transcript.
 *
 * `afterMs` scopes the sum to ONE turn. A Claude transcript is cumulative — it
 * holds every turn of the session — so an unscoped sum returns session-to-date
 * totals. Callers that ADD the result to a running total (accumulateSessionCost)
 * must pass the turn's start time, or an N-turn session is counted
 * quadratically. Codex reports a per-run delta already; this is what makes the
 * two engines agree.
 */
export function sumTranscriptUsage(content: string, afterMs?: number): TranscriptUsage {
  const u: TranscriptUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    assistantTurns: 0,
  };
  const seen = new Set<string>();
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let msg: any;
    try { msg = JSON.parse(t); } catch { continue; }
    if (msg.type !== "assistant") continue;
    if (afterMs !== undefined) {
      const ts = transcriptLineTimestampMs(msg);
      // An untimestamped line can't be placed in a turn. Skip it rather than
      // attribute another turn's tokens to this one.
      if (ts === undefined || ts < afterMs) continue;
    }
    const usage = msg?.message?.usage;
    if (!usage) continue;
    // Phase 0 finding: --effort high emits two assistant lines per response
    // (thinking + text) with the same message.id and identical usage. Dedupe
    // by message.id so tokens aren't double-counted. Lines without an id are
    // always counted (can't dedupe what we can't key).
    const id = msg?.message?.id;
    if (typeof id === "string") {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    u.assistantTurns += 1;
    u.inputTokens += Number(usage.input_tokens ?? 0);
    u.outputTokens += Number(usage.output_tokens ?? 0);
    u.cacheReadTokens += Number(usage.cache_read_input_tokens ?? 0);
    u.cacheWriteTokens += Number(usage.cache_creation_input_tokens ?? 0);
  }
  return u;
}

/** The input-context size (input + cache-read + cache-creation tokens) of this
 *  turn's last request — how full the window is — from transcript entries at or
 *  after `afterMs`. Undefined when the transcript has none of this turn's yet:
 *  the newest entry would then be an EARLIER turn's, and the meter the turn
 *  streamed live is the better reading. */
function lastTurnContextTokens(transcriptPath: string, afterMs: number): number | undefined {
  let content: string;
  try { content = fs.readFileSync(transcriptPath, "utf-8"); } catch { return undefined; }
  let last: number | undefined;
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let msg: any;
    try { msg = JSON.parse(t); } catch { continue; }
    if (msg.type !== "assistant") continue;
    const at = transcriptLineTimestampMs(msg);
    if (at === undefined || at < afterMs) continue;
    const u = msg?.message?.usage;
    if (!u) continue;
    last = Number(u.input_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0);
  }
  return last && last > 0 ? last : undefined;
}

/**
 * The context size either side of a `/compact`, from the `compact_boundary`
 * entry Claude Code writes when one finishes: `{type:"system",
 * subtype:"compact_boundary", compactMetadata:{trigger, preTokens, postTokens}}`
 * (seen from 2.1.261 on). The newest manual one at or after `afterMs` — an
 * earlier boundary, or an auto-compaction, is not the one asked for. Empty when
 * the transcript has none (or is on another host): the compaction still happened,
 * PostCompact said so, there are just no numbers to show. Exported for tests.
 */
export function compactionStatsFromTranscript(transcriptPath: string, afterMs: number): CompactionStats {
  let content: string;
  try { content = fs.readFileSync(transcriptPath, "utf-8"); } catch { return {}; }
  let stats: CompactionStats = {};
  for (const line of content.split("\n")) {
    if (!line.includes("compact_boundary")) continue;
    let msg: any;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg?.type !== "system" || msg.subtype !== "compact_boundary") continue;
    const meta = msg.compactMetadata;
    if (!meta || meta.trigger === "auto") continue;
    const at = transcriptLineTimestampMs(msg);
    if (at !== undefined && at < afterMs) continue;
    const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined);
    stats = {};
    const pre = count(meta.preTokens);
    const post = count(meta.postTokens);
    if (pre !== undefined) stats.preTokens = pre;
    if (post !== undefined) stats.postTokens = post;
  }
  return stats;
}

/** How long to wait for the `compact_boundary` after PostCompact has fired. */
const COMPACT_BOUNDARY_WAIT_MS = 2_000;
const COMPACT_BOUNDARY_POLL_MS = 100;

/**
 * The sizes of a compaction PostCompact has just confirmed. Claude Code fires
 * the hook BEFORE it appends the `compact_boundary` to the transcript (25 ms
 * apart on 2.1.284, live through the gateway), so a single read at settle time
 * finds nothing. Poll briefly; a transcript that cannot be read at all (on
 * another host) is not waited on. Exported for tests.
 */
export async function awaitCompactionStats(
  transcriptPath: string,
  afterMs: number,
  waitMs = COMPACT_BOUNDARY_WAIT_MS,
): Promise<CompactionStats> {
  if (!fs.existsSync(transcriptPath)) return {};
  let stats: CompactionStats = {};
  await pollUntil(() => {
    stats = compactionStatsFromTranscript(transcriptPath, afterMs);
    return stats.preTokens !== undefined || stats.postTokens !== undefined;
  }, waitMs, COMPACT_BOUNDARY_POLL_MS);
  return stats;
}

/** How long to wait for a turn's answer to reach the transcript after its Stop. */
const TURN_ANSWER_WAIT_MS = 2_000;
const TURN_ANSWER_POLL_MS = 50;
/** How much of the transcript's end is read for the answer. Only the end can
 *  hold it, and a transcript runs to tens of megabytes. */
const TURN_ANSWER_TAIL_BYTES = 256 * 1024;

/** Check `done` until it says so or `waitMs` has passed. */
async function pollUntil(done: () => boolean, waitMs: number, pollMs: number): Promise<void> {
  const deadline = Date.now() + waitMs;
  while (!done() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** The last `bytes` of a file, or undefined when it cannot be read. The first
 *  line may be cut; a JSONL reader skips it. */
function readTail(filePath: string, bytes: number): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf-8");
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* already gone */ }
  }
}

/** Whether the end of the transcript holds the answer the Stop hook reported,
 *  written at or after `afterMs`; undefined when it cannot be read. Exported
 *  for tests. */
export function transcriptHasTurnAnswer(transcriptPath: string, afterMs: number, answer: string): boolean | undefined {
  const tail = readTail(transcriptPath, TURN_ANSWER_TAIL_BYTES);
  if (tail === undefined) return undefined;
  const written = lastAssistantText(tail, afterMs);
  return written !== undefined && promptFingerprint(sanitizeAssistantText(written)) === promptFingerprint(answer);
}

/**
 * Wait for the turn's answer to be on disk before the transcript is read for
 * its cost. Claude Code fires Stop before it has flushed the turn's last
 * assistant entries, so a single read at settle time can miss the whole of a
 * short turn — typically one answering a notification — and its cost comes out
 * empty. Bounded. Between checks only the file's size is looked at; its end is
 * re-read only when it has grown. A transcript that cannot be read (on another
 * host, or not ours to read) is not waited on.
 */
async function awaitTurnAnswerInTranscript(transcriptPath: string, afterMs: number, answer: string): Promise<void> {
  let checkedSize = -1;
  await pollUntil(() => {
    let size: number;
    try { size = fs.statSync(transcriptPath).size; } catch { return true; }
    if (size === checkedSize) return false;
    checkedSize = size;
    return transcriptHasTurnAnswer(transcriptPath, afterMs, answer) !== false;
  }, TURN_ANSWER_WAIT_MS, TURN_ANSWER_POLL_MS);
}

/** Where this turn's transcript entries start. Entries before it belong to a
 *  background re-invocation the prompt waited behind or was queued behind. */
function turnTranscriptStart(promptWrittenAt: number, resolver: TurnResolver): number {
  return Math.max(promptWrittenAt, resolver.backgroundRerunEndedAt ?? 0);
}

export { findTranscriptForSession } from "./claude-transcript-path.js";

/** Last assistant text block from a Claude transcript — the turn's final
 *  message. Used to recover result text when the Stop hook (which normally
 *  carries last_assistant_message) was lost (gateway restart deleting
 *  gateway.json mid-turn, PTY crash, or SSE drop), so the parent-session
 *  callback shows real output instead of "(no output)". Exported for tests. */
function transcriptLineTimestampMs(msg: any): number | undefined {
  const raw = msg?.timestamp ?? msg?.created_at ?? msg?.createdAt;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function lastAssistantTextFromTranscript(transcriptPath: string, afterMs?: number): string | undefined {
  let raw: string;
  try { raw = fs.readFileSync(transcriptPath, "utf-8"); } catch { return undefined; }
  return lastAssistantText(raw, afterMs);
}

/** Last assistant text block in transcript JSONL, at or after `afterMs` when given. */
function lastAssistantText(raw: string, afterMs?: number): string | undefined {
  let last: string | undefined;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let msg: any;
    try { msg = JSON.parse(t); } catch { continue; }
    if (msg.type !== "assistant") continue;
    if (afterMs !== undefined) {
      const ts = transcriptLineTimestampMs(msg);
      if (ts === undefined || ts < afterMs) continue;
    }
    const content = msg?.message?.content;
    if (!Array.isArray(content)) continue;
    const text = content.filter((b: any) => b?.type === "text").map((b: any) => String(b.text ?? "")).join("");
    if (text.trim()) last = text;
  }
  return last;
}

/** Whitespace-collapsed, backtick-free: what survives both the paste's image-path
 *  quoting (neutralizeImagePathsForPaste) and the TUI's line handling. */
function promptFingerprint(text: string): string {
  return text.replace(/`/g, "").replace(/\s+/g, " ").trim();
}

/** Whether `prompt` reached the transcript as a user prompt at or after
 *  `sinceMs`. Other user entries — a background re-run's `<task-notification>`,
 *  an interrupt marker — do not count. Scans from the end, where anything this
 *  recent is, and stops at the first entry older than `sinceMs`. Unreadable
 *  counts as no. */
export function transcriptHasPromptSince(transcriptPath: string, sinceMs: number, prompt: string): boolean {
  const needle = promptFingerprint(prompt).slice(0, 200);
  if (!needle) return false;
  let raw: string;
  try { raw = fs.readFileSync(transcriptPath, "utf-8"); } catch { return false; }
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (!t) continue;
    let msg: any;
    try { msg = JSON.parse(t); } catch { continue; }
    const ts = transcriptLineTimestampMs(msg);
    if (ts !== undefined && ts < sinceMs) return false;
    if (msg.type !== "user" || ts === undefined) continue;
    const content = msg?.message?.content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content) ? content.filter((b: any) => b?.type === "text").map((b: any) => String(b.text ?? "")).join("\n") : "";
    if (promptFingerprint(text).includes(needle)) return true;
  }
  return false;
}

export function stripReasoningBlocks(text: string): string {
  return text
    .replace(/<\s*(thinking|reasoning|thought)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/```(?:thinking|reasoning|thought)\b[\s\S]*?```/gi, "")
    .trim();
}

/** The Claude engine emits `<suggestion>…</suggestion>` — a model-generated *suggested
 *  next user turn*. Jinn has no producer or consumer for the tag, so it lands in stored
 *  transcripts as `role: "assistant"` content, where another agent reading the session
 *  cannot tell it from an operator instruction. See issue #102.
 *
 *  STRIP, never drop the whole message: the observed shape is most often a suggestion
 *  fused to the FRONT of a genuine reply with no separator, so dropping would trade an
 *  information leak for silent data loss. Callers drop only when nothing but whitespace
 *  survives (the standalone shape). Kept separate from stripReasoningBlocks so private
 *  reasoning and suggested user turns stay independently testable. */
export function stripSuggestionBlocks(text: string): string {
  return text
    // Complete block, anywhere in the message.
    .replace(/<\s*suggestion\b[^>]*>[\s\S]*?<\s*\/\s*suggestion\s*>/gi, "")
    // Opened and never closed (message ends inside the block) — fail closed: everything
    // from the opening tag on is suggestion text, so strip to end of string.
    .replace(/<\s*suggestion\b[^>]*>[\s\S]*$/i, "")
    // Message ends part-way THROUGH the opening tag (`…<sugges`). Nothing genuine can
    // follow it, and leaving the fragment would leak a half-rendered tag — drop it.
    .replace(/<\s*s(?:u(?:g(?:g(?:e(?:s(?:t(?:i(?:o(?:n)?)?)?)?)?)?)?)?)?$/i, "")
    .trim();
}

/** Every path that stores or relays engine assistant text runs this. The two strippers
 *  stay separate above; composing them in one place means no call site can accidentally
 *  apply only one of them. */
export function sanitizeAssistantText(text: string): string {
  return stripSuggestionBlocks(stripReasoningBlocks(text));
}

/** Cost for ONE turn. `afterMs` (the turn's start) scopes the cumulative
 *  transcript to this turn — see sumTranscriptUsage. */
export function computeInteractiveCost(transcriptPath: string, model?: string, afterMs?: number): { cost: number; turns: number } | null {
  let content: string;
  try { content = fs.readFileSync(transcriptPath, "utf-8"); } catch { return null; }
  const u = sumTranscriptUsage(content, afterMs);
  if (u.assistantTurns === 0) return null;
  const cost = costOfUsage(model, {
    inputTokens: u.inputTokens,
    cachedInputTokens: u.cacheReadTokens,
    cacheWriteInputTokens: u.cacheWriteTokens,
    outputTokens: u.outputTokens,
  });
  if (cost === undefined) return null;
  return { cost, turns: u.assistantTurns };
}

/**
 * Map a StopFailure payload to an EngineRateLimitInfo in the shape ClaudeEngine
 * produces from `rate_limit_event` JSON, so detectRateLimit() and manager.ts's
 * wait-retry machinery work unchanged. The payload never names the reset, so a
 * rate-limit failure — and only that one — asks the account's usage source.
 */
export async function rateLimitFromStopFailure(payload: HookPayload | undefined): Promise<EngineRateLimitInfo | null> {
  if (!payload || payload.hook_event_name !== "StopFailure") return null;
  if (payload.error !== "rate_limit") return null;
  const resetsAt = await claudeResetsAtSeconds();
  return { status: "rejected", rateLimitType: "interactive_detected", ...(resetsAt === undefined ? {} : { resetsAt }) };
}

/**
 * The prompt is user text, and the claude CLI's parser reads a leading dash as a
 * flag (`error: unknown option '- '`), killing the PTY before the turn starts. So
 * the prompt trails everything behind `--`. That is also the only placement that
 * works: put it earlier and the variadic `--mcp-config` swallows it; put `--`
 * earlier and the flags after it become positionals.
 */
export function buildInteractiveArgs(o: InteractiveArgsOpts): string[] {
  const args: string[] = [];
  if (o.resumeSessionId) args.push("--resume", o.resumeSessionId);

  let prompt = o.prompt;
  if (o.attachments?.length) {
    prompt += buildAttachmentSuffix(o.attachments);
  }

  args.push("--chrome");
  if (o.effortLevel && o.effortLevel !== "default") args.push("--effort", o.effortLevel);
  if (o.model) args.push("--model", o.model);
  args.push("--dangerously-skip-permissions");
  args.push("--disallowedTools", "AskUserQuestion", "ExitPlanMode");
  args.push("--settings", o.settingsPath);
  if (o.appendSystemPrompt) args.push("--append-system-prompt", o.appendSystemPrompt);
  if (o.cliFlags?.length) args.push(...o.cliFlags);
  if (o.mcpConfigPath) args.push("--mcp-config", o.mcpConfigPath);
  args.push("--", prompt);
  return args;
}

/**
 * The message a turn hands Claude Code, in argv or pasted. On a fresh session the system
 * prompt is NOT folded in front of it, as buildPromptWithPlatformContext does
 * for engines that have no system-prompt flag: here it already travels in
 * `--append-system-prompt`. Folding it in as well sent the whole context twice
 * on every session's first turn, and put up to the full context budget into
 * the same argument as the message, against the exec's per-argument limit
 * (argv-limit.ts). A resumed session still gets its platform-context refresh.
 */
export function spawnPrompt(opts: Pick<EngineRunOpts, "prompt" | "resumeSessionId" | "platformContextRefresh">): string {
  return buildPromptWithPlatformContext({ prompt: opts.prompt, resumeSessionId: opts.resumeSessionId, platformContextRefresh: opts.platformContextRefresh });
}

/** What an argument of {@link buildInteractiveArgs}'s output is, for an error
 *  that names the one that was too long. */
export function describeInteractiveArgument(args: readonly string[], index: number): string {
  if (index === args.length - 1 && args[index - 1] === "--") return "the message (with its attachment list)";
  if (args[index - 1] === "--append-system-prompt") return "the system prompt";
  return `command-line argument ${index + 1}`;
}

/**
 * Translate one tool hook into StreamDeltas.
 *  - PostToolUse → `tool_result` (the completion marker; the SSE stream has none).
 *  - PreToolUse  → `tool_use`. On a local session the SSE proxy has usually
 *    reported the same call already and the turn drops the repeat by tool id;
 *    the hook is the only report of a call made inside a sub-agent (whose
 *    stream the proxy does not tee) or on a session with no proxy at all (a
 *    remote one, or one whose proxy failed to bind). A sub-agent's hooks carry
 *    `agent_id`, which marks the call as a sidechain.
 */
export function claudeHookToDeltas(h: Record<string, unknown>): StreamDelta[] {
  if (h.hook_event_name === "PreToolUse") return claudePreToolUseToDeltas(h);
  if (h.hook_event_name !== "PostToolUse") return [];
  const toolName = typeof h.tool_name === "string" ? h.tool_name : undefined;
  const response = h.tool_response;
  const responseRecord = response && typeof response === "object" && !Array.isArray(response)
    ? response as Record<string, unknown>
    : undefined;
  const responseText = Array.isArray(responseRecord?.content)
    ? (responseRecord.content as unknown[])
        .find((entry) => entry && typeof entry === "object" && (entry as Record<string, unknown>).type === "text")
    : undefined;
  const receiptSource = responseText && typeof responseText === "object"
    ? (responseText as Record<string, unknown>).text
    : response;
  const isError = h.is_error === true || responseRecord?.isError === true || responseRecord?.is_error === true;
  const activityReceiptId = extractActivityReceiptId(receiptSource, { isError });
  const toolId = typeof h.tool_use_id === "string" && h.tool_use_id ? h.tool_use_id : undefined;
  return [{
    type: "tool_result",
    content: String(h.tool_name ?? ""),
    toolName,
    ...(toolId ? { toolId } : {}),
    ...(activityReceiptId ? { activityReceiptId } : {}),
  }];
}

function claudePreToolUseToDeltas(h: Record<string, unknown>): StreamDelta[] {
  // Without an id the call cannot be matched against the proxy's report of it,
  // and recording it twice is worse than relying on the proxy alone.
  const toolId = typeof h.tool_use_id === "string" && h.tool_use_id ? h.tool_use_id : undefined;
  if (!toolId) return [];
  const toolName = typeof h.tool_name === "string" && h.tool_name ? h.tool_name : "tool";
  return [{
    type: "tool_use",
    content: toolName,
    toolName,
    toolId,
    ...(typeof h.agent_id === "string" ? { sidechain: true } : {}),
  }];
}

/**
 * Translate one parsed Anthropic SSE `data:` event into StreamDeltas. This is the
 * live streaming source (replacing the old transcript tailer): word-by-word text
 * in true order, tool markers positioned correctly relative to text, and live
 * context tokens from message_start.usage.
 *  - message_start.usage         → `context` (input + cache_read + cache_creation)
 *  - content_block_start tool_use → `tool_use` marker (in-order with text)
 *  - content_block_delta text_delta → incremental `text` (word-by-word)
 * tool_result is NOT in the assistant SSE stream (tools run between messages); the
 * PostToolUse hook supplies that completion marker. input_json_delta / thinking
 * deltas are intentionally not surfaced to the chat pane.
 */
export function sseEventToDeltas(e: SseDataEvent): StreamDelta[] {
  switch (e.type) {
    case "message_start": {
      const u = (e as any).message?.usage;
      if (!u) return [];
      const ctx = Number(u.input_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0);
      return ctx > 0 ? [{ type: "context", content: String(ctx) }] : [];
    }
    case "content_block_start": {
      const cb = (e as any).content_block;
      if (cb?.type === "tool_use") {
        return [{ type: "tool_use", content: String(cb.name ?? "tool"), toolName: String(cb.name ?? "tool"), toolId: String(cb.id ?? "") }];
      }
      return [];
    }
    case "content_block_delta": {
      const d = (e as any).delta;
      if (d?.type === "text_delta" && typeof d.text === "string" && d.text.length > 0) {
        return [{ type: "text", content: d.text }];
      }
      return [];
    }
    default:
      return [];
  }
}

/** Claude Code runs auto-compaction (and `/compact`) as an ordinary API call through
 *  this same proxy — same tools, same sentinel system prompt — so it passes every
 *  tee gate and its summarizer output used to stream into the chat as one enormous
 *  `<analysis>…</analysis><summary>This session is being continued…</summary>`
 *  bubble. The reliable marker is that this is the one assistant message that OPENS
 *  with `<analysis>`, so hold each message's first characters until that is decided
 *  and drop the whole message when it matches. */
const COMPACTION_OPENER = "<analysis>";

/** The other engine meta-tag that must never reach a transcript: a suggested next
 *  user turn (issue #102). Unlike `<analysis>` this is STRIPPED, not dropped — it is
 *  usually fused to the front of a genuine reply, so dropping the message would lose
 *  real content. The gate only needs the head-of-message case; `last_assistant_message`
 *  is sanitized independently by sanitizeAssistantText, which handles every position. */
const SUGGESTION_TAG = "<suggestion";
const SUGGESTION_OPEN_RE = /^<\s*suggestion\b[^>]*>/i;
const SUGGESTION_CLOSE_RE = /<\s*\/\s*suggestion\s*>/i;

/** True while `s` is still a viable prefix of an opener the gate might act on, so it
 *  must keep holding rather than latch `pass`. Handles an opening tag split across
 *  stream deltas (`<sugg` + `estion>`). */
function couldBeOpener(s: string): boolean {
  if (!s) return true;
  if (COMPACTION_OPENER.startsWith(s)) return true; // case-sensitive: unchanged behaviour
  const lower = s.toLowerCase();
  if (SUGGESTION_TAG.startsWith(lower)) return true;
  // `<suggestion …` with attributes still arriving — not yet a prefix of any literal.
  if (lower.startsWith(SUGGESTION_TAG) && !lower.includes(">")) return true;
  return false;
}

/** Per-message gate: buffers the opening text of an assistant message just long
 *  enough to tell a real reply from a compaction summary (dropped whole) or a leading
 *  suggested-user-turn block (stripped, remainder kept). Exported for tests. */
export class CompactionStreamGate {
  private held: StreamDelta[] = [];
  private opening = "";
  private verdict: "undecided" | "pass" | "drop" | "stripping" = "undecided";
  /** Text seen since a `<suggestion>` opener, awaiting its close tag. */
  private stripBuf = "";

  /** A new assistant message started — decide again from scratch. */
  reset(): void {
    this.held = [];
    this.opening = "";
    this.stripBuf = "";
    this.verdict = "undecided";
  }

  /** Deltas safe to forward now. Text is briefly held while the opener is undecided. */
  accept(deltas: StreamDelta[]): StreamDelta[] {
    const out: StreamDelta[] = [];
    for (const d of deltas) {
      if (this.verdict === "drop") continue;
      if (this.verdict === "pass") { out.push(d); continue; }
      // Inside a `<suggestion>` block: swallow text until the close tag, then release
      // the genuine reply that follows it (and everything after) untouched. A non-text
      // delta cannot close the block, so it is swallowed too.
      if (this.verdict === "stripping") {
        if (d.type !== "text") continue;
        this.stripBuf += String(d.content ?? "");
        out.push(...this.consumeStripping());
        continue;
      }
      // `context` is the FIRST delta of every message (message_start carries
      // usage), so deciding the verdict on it would latch `pass` before any
      // text arrives and the gate would never drop anything. Forward it and
      // keep deciding.
      if (d.type === "context") { out.push(d); continue; }
      // Any other non-text delta (a tool call) can never be a compaction summary.
      if (d.type !== "text") { this.verdict = "pass"; out.push(...this.flush(), d); continue; }
      this.opening += String(d.content ?? "");
      this.held.push(d);
      const trimmed = this.opening.trimStart();
      if (trimmed.startsWith(COMPACTION_OPENER)) { this.verdict = "drop"; this.held = []; continue; }
      const open = SUGGESTION_OPEN_RE.exec(trimmed);
      if (open) {
        // Discard the held opener text; keep scanning for the close tag.
        this.held = [];
        this.verdict = "stripping";
        this.stripBuf = trimmed.slice(open[0].length);
        out.push(...this.consumeStripping());
        continue;
      }
      if (couldBeOpener(trimmed)) continue; // still could be it
      this.verdict = "pass";
      out.push(...this.flush());
    }
    return out;
  }

  /** Message finished — release anything still held (messages shorter than the opener).
   *  An unterminated `<suggestion>` block releases nothing: fail closed. */
  end(): StreamDelta[] {
    const out = this.verdict === "drop" || this.verdict === "stripping" ? [] : this.flush();
    this.reset();
    return out;
  }

  /** Emit the remainder of a suggestion block once its close tag has arrived. */
  private consumeStripping(): StreamDelta[] {
    const close = SUGGESTION_CLOSE_RE.exec(this.stripBuf);
    if (!close) return []; // block still open — keep swallowing
    const rest = this.stripBuf.slice(close.index + close[0].length);
    this.stripBuf = "";
    this.verdict = "pass";
    return rest ? [{ type: "text", content: rest }] : [];
  }

  private flush(): StreamDelta[] {
    const h = this.held;
    this.held = [];
    return h;
  }
}

const STOP_FAILURE_GRACE_MS = 20_000;
/** StopFailure errors that must settle immediately. Rate-limit/billing/auth
 *  need the manager fallback machinery right away; everything else gets a grace
 *  window because Claude Code can keep working after a sub-agent/API failure. */
const IMMEDIATE_STOP_FAILURE_ERRORS = new Set(["rate_limit", "billing_error", "authentication_failed", "max_output_tokens"]);

export interface TurnResolverOpts {
  fallbackSessionId: string | undefined;
  /** When true (warm-PTY reuse / post-idle-spawn), the resolver skips waiting for
   *  SessionStart (it already fired once at process start) and pre-fills the
   *  Claude session id from fallbackSessionId. */
  assumeStarted?: boolean;
  /** Test override for the StopFailure grace window (default 20s). */
  stopFailureGraceMs?: number;
  /** While true, a graced StopFailure keeps waiting instead of settling. */
  shouldDeferStopFailure?: () => boolean;
  /** This turn is a Claude-native local command (see isNativeClaudeCommand). Such
   *  commands produce no new assistant message, so a Stop hook's
   *  last_assistant_message is the PREVIOUS turn's stale text — maybeComplete must
   *  settle empty rather than re-persist it as a duplicate. */
  native?: boolean;
  /** Warm-PTY turns only. The operator can type turns straight into
   *  the TUI. run() waits for such a turn to finish before pasting; what this
   *  gate adds is that a Stop/StopFailure counts only after this turn's own
   *  UserPromptSubmit has arrived live. It does NOT protect a turn pasted behind
   *  one still running: Claude Code fires a queued prompt's UPS at once, so the
   *  running turn's Stop would follow ours. Only the wait prevents that.
   *  Safe to require: the hook relay awaits delivery and Claude Code blocks on a
   *  UserPromptSubmit hook, so a turn's UPS always lands before its Stop. */
  requireLivePromptSubmit?: boolean;
  /** Warm-PTY turns: a background re-invocation (see
   *  isBackgroundReinvocation) was already running when this turn registered,
   *  so the next Stop is its, not ours. */
  backgroundRerunInProgress?: boolean;
  /** Warm-PTY turns: the prompt is pasted after registration, so a prompt
   *  submitted before promptWritten() was typed into the terminal — never ours
   *  (the paste can be held behind a background re-run for
   *  as long as it runs, and the operator may type meanwhile). */
  ownPromptAfterPaste?: boolean;
  /** Receives a Stop that belongs to a turn this resolver does not own, so that
   *  turn still reaches chat. */
  onForeignStop?: (h: HookPayload) => void;
}

/** Hook delivery context. `replayed` marks events the registry buffered before
 *  this turn registered: they happened before our prompt was even written. */
export interface HookDelivery {
  replayed?: boolean;
}

/** Whose turn a hook belongs to, as far as the resolver can tell: "foreign"
 *  hooks come from a turn this resolver does not own, and must not stream into,
 *  acknowledge or settle it. */
export type HookOwner = "own" | "foreign";

/** Claude Code re-invokes the model when a background task finishes, through
 *  a UserPromptSubmit whose prompt is a `<task-notification>` (verified on
 *  2.1.283). Nobody on the gateway asked for that turn, and no run() owns it. */
export function isBackgroundReinvocation(h: HookPayload): boolean {
  return h.hook_event_name === "UserPromptSubmit"
    && typeof h.prompt === "string"
    && h.prompt.trimStart().startsWith("<task-notification>");
}

/** Whether a hook ends the turn it belongs to. A StopFailure the CLI survives
 *  (anything outside IMMEDIATE_STOP_FAILURE_ERRORS) is usually retried, and the
 *  retry's Stop is still that turn's — so it does not end a background
 *  re-invocation either. */
function endsTurn(h: HookPayload): boolean {
  return h.hook_event_name === "Stop"
    || (h.hook_event_name === "StopFailure" && IMMEDIATE_STOP_FAILURE_ERRORS.has(String(h.error ?? "unknown")));
}

/** State machine for one interactive turn: resolves after BOTH SessionStart + Stop, or on StopFailure/interrupt. */
export class TurnResolver {
  readonly promise: Promise<EngineResult>;
  private resolve!: (r: EngineResult) => void;
  private settled = false;
  private claudeSessionId: string | undefined;
  private gotSessionStart = false;
  /** Whether the process now serving this turn has reported SessionStart. A
   *  turn can change process mid-way (redelivery by respawn), and each new one
   *  has to start before a death can count as an interruption. */
  private processStarted = false;
  private stopPayload: HookPayload | undefined;
  private stopFailurePayload: HookPayload | undefined;
  private graceTimer: NodeJS.Timeout | undefined;
  /** A background re-invocation is running ahead of this turn's prompt. */
  private rerunAhead: boolean;
  private rerunEndedAt: number | undefined;
  /** When this turn's own UserPromptSubmit arrived live, if it has. */
  private ownPromptAt: number | undefined;
  /** This turn's prompt is known to be the one Claude Code is running (as
   *  opposed to queued behind a background re-invocation). */
  private ownTurnRunning = false;
  /** Whether a live UserPromptSubmit can be this turn's own yet (see ownPromptAfterPaste). */
  private ownPromptArmed: boolean;

  constructor(private opts: TurnResolverOpts) {
    this.promise = new Promise((res) => { this.resolve = res; });
    if (opts.assumeStarted) {
      this.gotSessionStart = true;
      this.processStarted = true;
      this.claudeSessionId = opts.fallbackSessionId;
    }
    this.rerunAhead = opts.backgroundRerunInProgress === true;
    this.ownPromptArmed = opts.ownPromptAfterPaste !== true;
  }

  /** Our prompt is being written to the PTY now: the next live non-background
   *  UserPromptSubmit is ours. */
  promptWritten(): void { this.ownPromptArmed = true; }

  /**
   * Feed one hook to the turn. Returns "foreign" for a hook that belongs to a
   * turn this resolver does not own.
   *
   * Claude Code re-runs the model on its own when a background task finishes.
   * Verified on 2.1.283:
   *  - The re-run opens with a `<task-notification>` UserPromptSubmit, fired
   *    when it starts, and closes with one Stop. Notifications that finish
   *    together are batched into the same re-run.
   *  - A notification that lands while a turn runs waits for its Stop, or, at
   *    a tool boundary, is folded into it (no Stop of its own).
   *  - A prompt pasted while a re-run is in progress is queued, and its
   *    UserPromptSubmit fires at once: `UPS(bg) UPS(ours) Stop(bg) Stop(ours)`.
   *    If the re-run reaches a tool boundary first, the prompt is folded into
   *    it and there is only one Stop, carrying the re-run's answer.
   * So while a re-run is ahead of our prompt its Stop is not ours, and a Stop
   * replayed from the registry buffer finished before this turn registered.
   * Folding cannot be told apart from queueing until a tool boundary passes; a
   * PostToolUse after our prompt while the re-run is ahead means it was folded,
   * and the one Stop that follows is the only one this turn will get. run()
   * avoids that case by not pasting until a known re-run has finished.
   */
  onHook(h: HookPayload, delivery: HookDelivery = {}): HookOwner {
    if (this.settled) return "own";
    const event = h.hook_event_name;
    if (delivery.replayed && (event === "Stop" || event === "StopFailure" || event === "UserPromptSubmit")) {
      // Happened before our prompt was written. A foreign StopFailure is
      // dropped (its turn is not ours to fail); a foreign Stop goes to the
      // external-turn sync, since registering cancelled the registry's own
      // unclaimed-Stop handoff.
      if (event === "Stop") this.opts.onForeignStop?.(h);
      return "foreign";
    }
    if (event === "UserPromptSubmit") {
      if (isBackgroundReinvocation(h)) {
        // Folded into our running turn: its Stop is still ours.
        if (this.ownTurnRunning) return "own";
        // Otherwise it starts ahead of our prompt, before it was even read or
        // while it waits in Claude Code's queue.
        this.rerunAhead = true;
        return "foreign";
      }
      // Submitted before our paste: typed into the terminal, not ours.
      if (!this.ownPromptArmed) return "foreign";
      if (this.ownPromptAt === undefined) {
        this.ownPromptAt = Date.now();
        if (!this.rerunAhead) this.ownTurnRunning = true;
      }
      return "own";
    }
    // A background Task subagent's tool hooks (they carry agent_id) say nothing
    // about which top-level turn is running: they fire whenever it works.
    const subagentHook = typeof h.agent_id === "string";
    if (this.rerunAhead) {
      if (event === "Stop" || event === "StopFailure") {
        // A retryable StopFailure leaves the re-run running: its retry's Stop
        // is still the re-run's, so it stays ahead of our prompt.
        if (endsTurn(h)) {
          this.rerunAhead = false;
          this.rerunEndedAt = Date.now();
        }
        if (event === "Stop") this.opts.onForeignStop?.(h);
        return "foreign";
      }
      if (event === "PostToolUse" && this.ownPromptAt !== undefined && !subagentHook) {
        // The re-run reached a tool boundary with our prompt queued: Claude
        // Code folds it into the re-run, whose Stop is now the only one we get.
        this.rerunAhead = false;
        this.ownTurnRunning = true;
      }
      if (event === "PreToolUse" || event === "PostToolUse") return "foreign";
    } else if (this.ownPromptAt !== undefined && !subagentHook && (event === "PreToolUse" || event === "PostToolUse")) {
      // Our queued prompt is the one running now.
      this.ownTurnRunning = true;
    }
    if (this.opts.requireLivePromptSubmit && this.ownPromptAt === undefined
      && (event === "Stop" || event === "StopFailure")) {
      // Not ours: a turn typed into the TUI that finished before our queued
      // prompt ran. Settling on it would record the operator's answer as this
      // turn's reply. A foreign StopFailure is dropped (its turn is not ours to
      // fail); a foreign Stop goes to the external-turn sync.
      if (event === "Stop") this.opts.onForeignStop?.(h);
      return "foreign";
    }
    if (event === "SessionStart") {
      this.gotSessionStart = true;
      this.processStarted = true;
      if (typeof h.session_id === "string") this.claudeSessionId = h.session_id;
      this.maybeComplete();
    } else if (h.hook_event_name === "Stop") {
      // A Stop supersedes any pending StopFailure — the CLI retried and finished.
      this.clearGrace();
      this.stopFailurePayload = undefined;
      this.stopPayload = h;
      if (typeof h.session_id === "string" && !this.claudeSessionId) this.claudeSessionId = h.session_id;
      this.maybeComplete();
    } else if (h.hook_event_name === "StopFailure") {
      // API error ended the turn. In interactive mode the CLI survives
      // invalid_request/server_error/unknown and usually retries — hold the
      // failure in a grace window instead of settling: a later Stop supersedes
      // it, activity re-arms it, the PTY-death watchdog still fails fast.
      // Other error types (rate_limit, billing, auth) settle immediately.
      // numTurns:1 keeps isDeadSessionError from false-positiving.
      this.stopFailurePayload = h;
      if (typeof h.session_id === "string" && !this.claudeSessionId) this.claudeSessionId = h.session_id;
      if (!IMMEDIATE_STOP_FAILURE_ERRORS.has(String(h.error ?? "unknown"))) {
        this.armGrace();
      } else {
        this.settleWithFailure();
      }
    } else {
      // PreToolUse/PostToolUse/etc — proof of life while a failure is pending.
      this.noteActivity();
    }
    return "own";
  }

  /** A background re-invocation is running ahead of this turn's prompt. */
  get awaitingBackgroundRerun(): boolean { return this.rerunAhead; }
  /** When the last background re-invocation ahead of this turn ended. */
  get backgroundRerunEndedAt(): number | undefined { return this.rerunEndedAt; }
  /** The re-run ahead is taken to be over without its Stop (run()'s quiet
   *  backstop): the Stop was lost, and the next one is ours. */
  abandonBackgroundRerun(): void {
    if (!this.rerunAhead) return;
    this.rerunAhead = false;
    this.rerunEndedAt = Date.now();
  }

  /** When this turn's own UserPromptSubmit arrived live, if it has. */
  get promptSubmittedAt(): number | undefined { return this.ownPromptAt; }
  /** Claude session id learned so far (for engineSessionId persistence on warm-PTY turns). */
  get sessionId(): string | undefined { return this.claudeSessionId; }
  get isSettled(): boolean { return this.settled; }
  /** The StopFailure payload, if the turn ended in an API error (Task 5.3 maps it to rateLimit). */
  get stopFailure(): HookPayload | undefined { return this.stopFailurePayload; }
  /** transcript_path from whichever hook carried it. */
  get transcriptPath(): string | undefined {
    const p = this.stopPayload?.transcript_path ?? this.stopFailurePayload?.transcript_path;
    return typeof p === "string" ? p : undefined;
  }

  private maybeComplete(): void {
    if (!this.gotSessionStart || !this.stopPayload) return;
    const sid = this.claudeSessionId ?? this.opts.fallbackSessionId;
    if (!sid) {
      this.settle({ sessionId: "", result: "", error: "Interactive turn produced no Claude session id" });
      return;
    }
    // Native local commands (/usage, /limits, …) produce no new assistant
    // message; the Stop hook's last_assistant_message is the prior turn's stale
    // text. Settling with it would persist a duplicate chat echo — settle empty.
    const text = this.opts.native ? "" : sanitizeAssistantText(String(this.stopPayload.last_assistant_message ?? ""));
    this.settle({ sessionId: sid, result: text, error: undefined, numTurns: 1 });
  }

  interrupt(reason: string): void {
    // PTY died while a StopFailure was held in grace — the API error is the
    // real cause; report it instead of the generic "process exited". Other
    // interrupt reasons (user abort, engine switch, preemption) keep their
    // "Interrupted: …" text so the quiet-interrupt handling downstream engages.
    if (this.stopFailurePayload && !this.settled && isProcessExitInterruption(reason)) {
      this.settleWithFailure();
      return;
    }
    this.settle({ sessionId: this.claudeSessionId ?? this.opts.fallbackSessionId ?? "", result: "", error: reason });
  }

  /** A new process is about to serve this turn (redelivery by respawn): until
   *  it reports SessionStart, its death is a failed start. */
  newProcess(): void {
    this.processStarted = false;
  }

  /** Whether the process serving this turn has reported SessionStart. */
  get started(): boolean {
    return this.processStarted;
  }

  /**
   * The turn's PTY process exited. Before SessionStart, Claude Code never ran
   * this turn: that is a failed start, reported with what the process printed
   * (processStartFailure), so it is not settled as a quiet interruption that
   * loses the reason. After SessionStart it was cut off mid-run, as before.
   */
  processExited(exit: PtyExit | undefined, output?: string): void {
    if (this.settled) return;
    if (!this.processStarted) {
      this.settle({ sessionId: this.claudeSessionId ?? this.opts.fallbackSessionId ?? "", result: "", error: processStartFailure("claude", exit, output) });
      return;
    }
    this.interrupt(processExitInterruption("claude", exit));
  }

  completeNativeCommand(): void {
    this.settle({ sessionId: this.claudeSessionId ?? this.opts.fallbackSessionId ?? "", result: "", numTurns: 1 });
  }

  completeRecovered(text: string, sessionId?: string): void {
    if (sessionId && !this.claudeSessionId) this.claudeSessionId = sessionId;
    this.settle({ sessionId: this.claudeSessionId ?? this.opts.fallbackSessionId ?? "", result: sanitizeAssistantText(text), numTurns: 1 });
  }

  /** Proof of life (SSE delta / tool hook) while a StopFailure is pending —
   *  re-arms the grace window. No-op when no failure is pending. */
  noteActivity(): void {
    if (this.graceTimer) this.armGrace();
  }

  private armGrace(): void {
    this.clearGrace();
    const ms = this.opts.stopFailureGraceMs ?? STOP_FAILURE_GRACE_MS;
    this.graceTimer = setTimeout(() => {
      if (this.opts.shouldDeferStopFailure?.()) {
        this.armGrace();
        return;
      }
      this.settleWithFailure();
    }, ms);
    this.graceTimer.unref?.();
  }

  private clearGrace(): void {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = undefined;
    }
  }

  private settleWithFailure(): void {
    this.settle({
      sessionId: this.claudeSessionId ?? this.opts.fallbackSessionId ?? "",
      result: "",
      error: `Interactive turn failed: ${this.stopFailurePayload?.error ?? "unknown"}`,
      numTurns: 1,
    });
  }

  private settle(r: EngineResult): void {
    if (this.settled) return;
    this.settled = true;
    this.clearGrace();
    this.resolve(r);
  }
}

/** How long activeStreams must sit at 0 (post-settle) before the engine reports
 *  the session's background activity as cleared. Background subagents fire
 *  consecutive API requests with small gaps between them — a quiet window keeps
 *  the indicator from flapping null↔active on every inter-request beat. */
const BACKGROUND_CLEAR_QUIET_MS = 10_000;

/** The one argument a remote spawn's message and system prompt travel in. */
const REMOTE_COMMAND_LINE = "the remote command line (the message and the system prompt together)";

/** How long a session's background sub-agents or re-run may go without a sign
 *  of life (a hook, an upstream request) before the engine stops counting them.
 *  Their end is only ever announced (a task notification, the re-run's Stop),
 *  so a lost announcement would otherwise report the session as running until
 *  its PTY died. A sub-agent running one long tool is silent for that long, so
 *  this is generous: the cost of tripping it is the old `idle`, not lost work. */
const BACKGROUND_SILENCE_MS = 30 * 60_000;

/** Task statuses TaskOutput reports for a task that is still going. */
const UNFINISHED_TASK_STATUSES = new Set(["running", "pending"]);

const NATIVE_COMMAND_QUIET_MS = 1800;
const NATIVE_COMMAND_MIN_MS = 3000;
const NATIVE_COMMAND_MAX_MS = 90_000;
/** `/compact` summarizes the whole transcript in one API call, which on a long
 *  session outlasts NATIVE_COMMAND_MAX_MS. It settles on PostCompact instead
 *  (see nativeCommandSettles); this is only the bound if that hook is lost. */
const COMPACT_COMMAND_MAX_MS = 15 * 60_000;

/**
 * Whether a native command's turn is over, by the quiet-window rule every
 * native command uses: a short minimum, then PTY output quiet for a beat.
 *
 * `/compact` adds two things. It is over at once when Claude Code reports
 * PostCompact (verified on 2.1.283: `/compact <instructions>` fires PreCompact,
 * SessionStart{source:"compact"}, PostCompact{trigger:"manual"}, and no Stop) —
 * handled by the hook listener, not here. And a quiet PTY is not enough while
 * the summarizing request is still in flight through the proxy: a turn settled
 * then would let the next queued prompt (a self-compaction's resume) be pasted
 * into a TUI that is still compacting.
 */
export function nativeCommandSettles(o: {
  compact: boolean;
  elapsedMs: number;
  quietForMs: number;
  upstreamActive: boolean;
}): boolean {
  if (o.elapsedMs >= (o.compact ? COMPACT_COMMAND_MAX_MS : NATIVE_COMMAND_MAX_MS)) return true;
  if (o.elapsedMs < NATIVE_COMMAND_MIN_MS || o.quietForMs < NATIVE_COMMAND_QUIET_MS) return false;
  return !(o.compact && o.upstreamActive);
}
const LOST_STOP_RECOVERY_QUIET_MS = 60_000;
const LOST_STOP_RECOVERY_MIN_MS = 5 * 60_000;
const LATE_RECOVERY_WINDOW_MS = 10 * 60 * 1000;
/**
 * Terminal backstop for a turn that produced no Stop hook AND cannot be
 * recovered from a transcript. Transcript recovery needs a Claude session id
 * (`resolver.sessionId ?? opts.resumeSessionId`); on a FRESH spawn ("resume:
 * none") whose SessionStart hook was also lost, both are undefined, so the
 * recovery interval can only ever return early. Without this the turn never
 * settles: the session is pinned at "running" forever and its queued messages
 * never dispatch. Deliberately far above the recovery thresholds so genuine
 * recovery always gets first refusal.
 */
const TURN_STALL_TIMEOUT_MS = 15 * 60_000;
const TURN_STALL_QUIET_MS = 5 * 60_000;
/** background re-invocation wait (see waitForBackgroundRerun). */
const BACKGROUND_RERUN_POLL_MS = 250;
const BACKGROUND_RERUN_SETTLE_MS = 750;
const BACKGROUND_RERUN_QUIET_MS = 15_000;

/** Stall predicate, split out so it is testable without a live PTY. Both bounds
 *  must hold: a long turn that is still streaming is healthy, and a brief quiet
 *  gap early in a turn is normal. Exported for tests. */
export function shouldSettleStalledTurn(elapsedMs: number, quietMs: number): boolean {
  return elapsedMs >= TURN_STALL_TIMEOUT_MS && quietMs >= TURN_STALL_QUIET_MS;
}

/**
 * Earliest transcript time lost-Stop recovery may take assistant text from.
 * Under the warm-PTY prompt gate that is our own UserPromptSubmit: before it,
 * transcript text belongs to a turn typed into the terminal, and with
 * no live UPS at all nothing in the transcript is ours. Exported for tests.
 */
export function recoveryFloorMs(
  gateOnPromptSubmit: boolean,
  turnStartedAt: number,
  promptSubmittedAt: number | undefined,
): number | undefined {
  return gateOnPromptSubmit ? promptSubmittedAt : turnStartedAt;
}

/** A turn typed into the terminal is over once the TUI has been silent this
 *  long with no upstream request in flight, unless a safety prompt is sitting
 *  at the bottom of the screen. Claude Code redraws its spinner and elapsed
 *  counter continuously while it works, tools included, so silence already
 *  means "not working"; the one silent-but-unfinished state is a dialog waiting
 *  on the operator. This is the backstop for the cases with no closing hook: a
 *  prompt Claude Code folded into the running turn (one Stop for two prompts),
 *  and a turn the operator interrupted with Esc (no Stop). Exported for tests. */
export const TERMINAL_TURN_QUIET_MS = 4_000;
const TERMINAL_TURN_POLL_MS = 250;
const TERMINAL_TURN_LOG_EVERY_MS = 5 * 60_000;
/**
 * There is deliberately no time limit on the wait (COO decision): a
 * gateway turn settled with the operator's typed answer is the bug this exists
 * to prevent. That is safe because the wait is reachable only after the
 * operator types a turn in the terminal (see isBackgroundReinvocation), it is
 * shown in the UI (`session:terminal-wait`, `turnProgress.waitingForTerminalTurn`),
 * and the operator's stop, a new message or "send now" end it at any time.
 */

/** Claude Code's input box line ("❯ " + draft) — not a "❯ 1. Yes" option. */
const CLAUDE_INPUT_LINE = /^\s*❯(?!\s*\d+\.)(\s|$)/;
const PROMPT_QUESTION = /^\s*Do you want to proceed\?\s*$/;
const PROMPT_OPTION = /^\s*(❯)?\s*\d+\.\s+\S/;

/** Claude Code's Esc Esc Rewind flow (JIN-3 / ). Two screens own the
 *  composer in turn, and both must be recognised before the gateway sends a CR:
 *
 *  1. the rewind list (a point picked with arrows), whose header and footer are
 *     the menu's own words and whose rewind points are free text; and
 *  2. the restore-confirm dialog shown after Enter, whose default highlight is
 *     the destructive "Restore conversation" / "Restore code and conversation".
 *
 *  Matching is prefix-anchored because the CLI wraps these labels at narrow
 *  widths: at 50 columns the description becomes "Restore the code and/or
 *  conversation to the" / "point before…", and at 30 the stage-2 label wraps to
 *  "Confirm you want to" / "restore to the point…". Detection is captured and
 *  verified down to 30 columns, the narrowest width the QA probes cover for both
 *  stages; below that the labels keep wrapping and the floor is untested.
 *  Captured on claude 2.1.284; the JIN-3 2.1.283 stage-1 shape is unchanged —
 *  see jin3-evidence/probes/out-escesc.txt and the QA frames (f30.json/f50.json/f140.json). */
const REWIND_TITLE = /^\s*Rewind\s*$/;
const REWIND_DESCRIPTION = /^\s*Restore the code\b/;
const REWIND_CONFIRM = /^\s*Confirm you want to\b/;
const REWIND_FOOTER = /^\s*Enter to continue\b/;

/** Index of the last row matching `test` at or after `from`, or -1. */
function lastMatchingRow(viewport: readonly string[], test: RegExp, from = 0): number {
  for (let row = viewport.length - 1; row >= from; row -= 1) {
    if (test.test(viewport[row])) return row;
  }
  return -1;
}

/**
 * Whether the viewport shows one of Claude Code's safety dialogs LIVE, as
 * opposed to conversation text that quotes one. A live dialog replaces the
 * input box, so no input line follows its options; a quoted dialog has the
 * idle input box below it. Deliberately fails CLOSED: the dialog's footer is
 * not required, because its wording is only verified on 2.1.220, and a missed
 * dialog is the dangerous direction — the gateway's paste would end in a CR,
 * which confirms the highlighted option ("1. Yes") of a prompt the operator
 * never saw answered. Exported for tests.
 */
export function viewportShowsLiveSafetyPrompt(viewport: readonly string[]): boolean {
  if (parsePermissionPrompt(viewport) === null) return false;
  let questionRow = -1;
  for (let row = viewport.length - 1; row >= 0; row -= 1) {
    if (PROMPT_QUESTION.test(viewport[row])) { questionRow = row; break; }
  }
  if (questionRow === -1) return false;
  let lastOptionRow = questionRow;
  for (let row = questionRow + 1; row < viewport.length; row += 1) {
    if (PROMPT_OPTION.test(viewport[row])) lastOptionRow = row;
    else if (viewport[row].trim() !== "" && lastOptionRow > questionRow) break;
  }
  return !viewport.slice(lastOptionRow + 1).some((line) => CLAUDE_INPUT_LINE.test(line));
}

/**
 * Stage 1: the rewind list. Its rewind points are free text, so it has no hard
 * edge of its own — the menu's footer closes the block. Live when no composer
 * line has come back below that footer (a transcript quoting the menu leaves
 * the idle composer visible below it).
 */
function rewindListIsLive(viewport: readonly string[], titleRow: number): boolean {
  const descriptionRow = viewport.findIndex((line, row) => row > titleRow && line.trim() !== "");
  if (descriptionRow === -1 || !REWIND_DESCRIPTION.test(viewport[descriptionRow])) return false;
  const footerRow = lastMatchingRow(viewport, REWIND_FOOTER, titleRow + 1);
  if (footerRow === -1) return false;
  return !viewport.slice(footerRow + 1).some((line) => CLAUDE_INPUT_LINE.test(line));
}

/**
 * Stage 2: the restore-confirm dialog. This one is the safety-prompt shape — a
 * question, then numbered ❯ options — so it uses the same last-option-plus-no-
 * composer edge, and its default highlight is the destructive option.
 */
function rewindConfirmIsLive(viewport: readonly string[], titleRow: number): boolean {
  let confirmRow = -1;
  for (let row = viewport.length - 1; row > titleRow; row -= 1) {
    if (REWIND_CONFIRM.test(viewport[row])) { confirmRow = row; break; }
  }
  if (confirmRow === -1) return false;
  let lastOptionRow = confirmRow;
  for (let row = confirmRow + 1; row < viewport.length; row += 1) {
    if (PROMPT_OPTION.test(viewport[row])) lastOptionRow = row;
    else if (viewport[row].trim() !== "" && lastOptionRow > confirmRow) break;
  }
  if (lastOptionRow === confirmRow) return false;
  return !viewport.slice(lastOptionRow + 1).some((line) => CLAUDE_INPUT_LINE.test(line));
}

/**
 * Whether Claude Code's Rewind flow is open on the viewport.
 *
 * With either screen up the composer is not accepting input: Claude Code drops
 * a bracketed paste whole and takes a submit CR as "Enter to continue" (stage 1)
 * or as the highlighted destructive default (stage 2), confirming the rewind —
 * and any restore that follows — while the gateway's message is lost (JIN-3,
 * ). Captured stage-1 shape (2.1.283/2.1.284):
 *
 *     Rewind
 *     Restore the code and/or conversation to the point before…
 *       <a rewind point>
 *       No code changes
 *     ❯ (current)
 *     Enter to continue · Esc to cancel
 *
 * and the stage-2 dialog that Enter opens:
 *
 *     Rewind
 *     Confirm you want to restore to the point before you sent this message:
 *     │ <the message>
 *     The conversation will be forked.
 *     The code will be unchanged.
 *     ❯ 1. Restore conversation
 *       2. Summarize from here
 *       3. Summarize up to here
 *       4. Never mind
 *
 * "Live", as opposed to transcript text that merely quotes a screen, is the
 * safety-prompt test: no composer line appears below the block. Exported for
 * tests.
 */
export function viewportShowsRewindMenu(viewport: readonly string[]): boolean {
  const titleRow = lastMatchingRow(viewport, REWIND_TITLE);
  if (titleRow === -1) return false;
  return rewindListIsLive(viewport, titleRow) || rewindConfirmIsLive(viewport, titleRow);
}
/** Interrupts that come from the operator acting on this message: the stop
 *  button, a new message, "send now". Landing on a gateway turn still waiting
 *  behind a turn typed in the terminal, they end the wait and leave the PTY —
 *  and the operator's turn in it — alone. Every other kill reason (reset,
 *  delete, fork, engine switch, restart, shutdown, workflow stop) tears the PTY
 *  down as it always did. */
const WAIT_ONLY_INTERRUPTS = new Set([USER_STOP_INTERRUPTION_REASON, USER_MESSAGE_INTERRUPTION_REASON]);

/**
 * Whether real work is in flight, and so missing-Stop recovery must hold off.
 *
 * A turn blocked on a safety prompt is the one case where a non-zero tool count
 * does NOT mean work is happening: PreToolUse fires, THEN the CLI sits on a
 * dialog nobody is there to answer. Counting that as busy suppressed the stall
 * backstop forever — sessions pinned at status:"running" for hours (one observed
 * at 9h26m) instead of failing after 15 minutes. Exported for tests.
 */
export function recoveryBlockedByWork(
  activeTools: number,
  blockedOnPermission: boolean,
  upstreamActive: boolean,
): boolean {
  return (activeTools > 0 && !blockedOnPermission) || upstreamActive;
}

/** Warm-PTY submit confirmation. The CR that submits a bracketed paste is not
 *  guaranteed to land — the TUI discards keypresses while it is busy, and
 *  backticking attachment paths only removes the one trigger we characterised
 *  (image auto-attach). When the CR is lost the text strands in the composer and
 *  the turn never starts. UserPromptSubmit is the CLI's acknowledgement; until it
 *  arrives, re-send the CR.
 *
 *  Retrying is the whole value here: a CR re-sent a second or two later succeeds
 *  where the fixed 150ms one failed. Deciding the prompt is dead is NOT part of
 *  the job — shouldSettleStalledTurn owns that, and a premature verdict would
 *  kill live work. So the window is generous and the outcome is a log line. */
const SUBMIT_CONFIRM_INTERVAL_MS = 1500;
const SUBMIT_CONFIRM_ATTEMPTS = 12;
/** Hooks that prove the pasted prompt is running. SessionStart is excluded on
 *  purpose: the idle spawn that warmed this PTY fires it before the paste. */
export const SUBMIT_ACK_HOOKS = new Set(["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "StopFailure"]);

/** How long to let the TUI settle before reading the screen back. The prompt is
 *  already drawn when Notification fires, so this only absorbs redraw jitter. */
const PERMISSION_PROMPT_SETTLE_MS = 400;
/** Re-read after answering to confirm the dialog actually cleared. */
const PERMISSION_PROMPT_VERIFY_MS = 1500;
/** Attempts before giving up and leaving the turn to the stall backstop. A
 *  prompt we cannot answer twice is one we do not understand; keystroke spam at
 *  an unrecognised dialog is exactly the failure mode worth avoiding. */
const PERMISSION_PROMPT_MAX_ATTEMPTS = 3;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });
}

/** True for the Notification hook that means "the CLI is blocked on a permission
 *  dialog". Verified against claude 2.1.220: notification_type is
 *  "permission_prompt" and it fires ~6s after the PreToolUse for the gated tool.
 *  Other Notification types (idle nudges) must not trip this. */
export function isPermissionPromptNotification(h: HookPayload | Record<string, unknown>): boolean {
  const payload = h as Record<string, unknown>;
  return payload.hook_event_name === "Notification"
    && payload.notification_type === "permission_prompt";
}

/** Moved to shared/skill-commands.ts so the turn preflight can ask it too; re-exported for callers here. */
export { isNativeClaudeCommand };

/** Per-session bookkeeping for the turn currently in flight. Everything here is
 *  in-memory and lives exactly as long as run() is pending, which is also exactly
 *  the window in which the gateway's 5s heartbeat is asserting status:"running".
 *  turnProgress() reads it so that assertion can be checked instead of trusted. */
interface ActiveTurn {
  resolver: TurnResolver;
  onStream?: (d: StreamDelta) => void;
  boundProc?: pty.IPty;
  /** Suppresses auto-compaction summaries from leaking into the chat stream. */
  gate?: CompactionStreamGate;
  /** Tool ids this turn has already reported as `tool_use`. A main-agent call
   *  is reported twice — by the SSE proxy and by its PreToolUse hook, in
   *  either order — and must be streamed (and recorded) once. */
  reportedToolIds?: Set<string>;
  /** Local tool calls in flight (PreToolUse seen, PostToolUse not yet). A long
   *  tool is real work, so a quiet PTY with tools running is NOT a stall. */
  activeTools: number;
  /** Set when the CLI reports it is blocked on one of Claude Code's hardcoded
   *  safety prompts (see claude-permission-prompt.ts). Load-bearing for the
   *  stall backstop: PreToolUse fires BEFORE the prompt, so activeTools is
   *  non-zero and a blocked turn is otherwise indistinguishable from a
   *  long-running tool — which is exactly why these hung forever instead of
   *  settling after 15 minutes. */
  blockedOnPermissionAt?: number;
  /** Guards the auto-approve retry loop against re-entry from a repeated hook. */
  approvingPermission?: boolean;
  startedAt: number;
  /** Last hook of any kind — proof of life independent of PTY redraw noise. */
  lastHookAt: number;
  /** Set once the CLI acknowledges the prompt. False forever = swallowed submit. */
  promptSubmitted: boolean;
  /** Warm-PTY turn under the UserPromptSubmit gate (see TurnResolverOpts). */
  gated?: boolean;
  /** Claude-native command: fires no UserPromptSubmit of its own. */
  native?: boolean;
  /** UserPromptSubmit hooks seen live while this turn ran. The first one of a
   *  non-native turn is its own (argv and pasted prompts both fire one —
   *  verified on 2.1.283); any other is somebody typing in the terminal. */
  promptSubmitsSeen?: number;
  /** Someone typed a prompt into the terminal while this turn ran. Claude Code
   *  queues it behind this turn (or folds it in), so after this turn settles a
   *  terminal turn may be starting. */
  terminalPromptQueued?: boolean;
  /** The paste is held behind a background re-invocation. */
  holdingPaste?: boolean;
  /** Stops the submit-confirmation retry loop; called when the turn settles. */
  cancelSubmitConfirm?: () => void;
}

/** Optional submit acknowledgement probe for pasteAndSubmit. Supplied by the
 *  gateway-driven warm-PTY path, where an unsubmitted prompt is an invisible hang;
 *  omitted for raw WS input, where a human is at the keyboard and can press Enter. */
export interface SubmitConfirmation {
  /** True once the CLI acknowledged the prompt (UserPromptSubmit or any in-turn hook). */
  submitted: () => boolean;
  /** True while the CLI is demonstrably doing real work — an upstream request in
   *  flight or a local tool running.
   *
   *  Both the retry and the give-up must pause on this. Claude Code QUEUES a
   *  pasted prompt behind a turn already running (a human typing in the CLI/xterm
   *  view, say). On 2.1.283 a queued prompt's UserPromptSubmit fires at once, but
   *  a busy TUI can also drop the CR, and while work is in flight the two are
   *  hard to tell apart: without this gate we would spray CRs at a busy TUI and
   *  then report a healthy turn as lost. */
  busy?: () => boolean;
  /** Consulted immediately before the first CR and before every re-sent one.
   *  Return true to write that CR nowhere and hand off to `onUnconfirmed`: the
   *  screen is in a state where a CR confirms something other than the prompt —
   *  Claude Code's Esc Esc Rewind menu, which takes Enter as "confirm rewind"
   *. Async because the reader takes the PTY snapshot's write queue,
   *  and it may open in the 150ms after the paste or between retries, so it has
   *  to be re-read each time. Omitted where no screen can claim the composer. */
  abortSubmit?: () => Promise<boolean>;
  /** Called before each re-sent CR. */
  onRetry?: (attempt: number) => void;
  /** Called when the retries are exhausted and the prompt is still unacknowledged.
   *  Never settles the turn (that verdict is shouldSettleStalledTurn's): run()
   *  uses it to redeliver the prompt by respawning (JIN-3). */
  onUnconfirmed?: (attempts: number) => void;
  /** Test overrides. */
  intervalMs?: number;
  attempts?: number;
}

/** Bracketed-paste `text` into a PTY then submit with CR after a 150ms beat.
 *  Phase 0 finding: bracketed-paste does NOT neutralize a leading /, @, or ! —
 *  they still trigger the slash-command / mention / bash-mode handlers and the
 *  turn is never submitted. neutralizeForPaste() prepends a space for mentions,
 *  bash-mode, and jinn-skill slash commands, while letting engine-native commands
 *  (/compact, /clear, /model, …) pass through raw so the TUI actually runs them.
 *  Shared by injectPrompt() (warm-PTY first turn) and writeStdin() (raw WS input).
 *
 *  Pass `confirm` to make the submit verified rather than assumed: the CR is
 *  re-sent until the CLI acknowledges the prompt, and `onUnconfirmed` fires if it
 *  never does. Backticking attachment paths (below) removes the known trigger for
 *  a swallowed CR; this covers the ones we have not characterised — a large paste
 *  into a TUI mid-redraw, or one near auto-compact. Returns a cancel function —
 *  the caller MUST call it when the turn settles (see the cancellation note). */
/**
 * Compose the "Attached files:" suffix, with every path wrapped in backticks.
 *
 * The backticks are load-bearing, not cosmetic. Claude Code's TUI scans
 * bracketed-paste text for tokens resolving to an existing IMAGE file and, on a
 * hit, enters an async "Pasting…" state while it reads and base64-encodes the
 * file into an `[Image #N]` chip. Keypresses are discarded while that state is
 * active — including pasteAndSubmit's submit CR, which fires on a fixed 150ms
 * timer. Any real screenshot takes longer than 150ms to encode, so the CR is
 * swallowed and the turn hangs forever: text sits in the input box, no spinner,
 * no error, no Stop hook.
 *
 * Verified against a live PTY (claude 2.1.220): a 5.8MB PNG hangs at 150ms and
 * submits at 400ms; the same path in backticks submits at 150ms every time.
 * Newlines are irrelevant — a zero-newline prompt with a real image path hangs,
 * and a three-newline prompt with a non-existent path submits.
 *
 * Backticks stop the path from being auto-attached, so there is no async state
 * to race. The model resolves the path with Read (which renders images), which
 * is already how the cold/argv path behaves — argv prompts never traverse the
 * TUI paste handler, so warm and cold now agree.
 */
export function buildAttachmentSuffix(attachments: readonly string[]): string {
  return "\n\nAttached files:\n" + attachments.map((a) => `- \`${a}\``).join("\n");
}

/** Keep bare image paths out of Claude Code's async paste-to-attachment path. */
export function neutralizeImagePathsForPaste(text: string): string {
  return text.replace(
    /(^|[\s(\[])(~?\/[^\s`'"]+\.(?:png|jpe?g|gif|webp|bmp|svg))(?=$|[\s)\]])/gi,
    (_match, prefix: string, imagePath: string) => `${prefix}\`${imagePath}\``,
  );
}

export function pasteAndSubmit(
  proc: Pick<pty.IPty, "write">,
  text: string,
  confirm?: SubmitConfirmation,
): () => void {
  const payload = neutralizeForPaste(text);
  proc.write(`\x1b[200~${payload}\x1b[201~`);
  let retryTimer: NodeJS.Timeout | undefined;
  let cancelled = false;
  const stopRetries = () => {
    if (retryTimer) clearInterval(retryTimer);
    retryTimer = undefined;
  };
  const startRetries = () => {
    if (!confirm || cancelled) return;
    const maxAttempts = confirm.attempts ?? SUBMIT_CONFIRM_ATTEMPTS;
    const intervalMs = confirm.intervalMs ?? SUBMIT_CONFIRM_INTERVAL_MS;
    let attempt = 0;
    const sendCr = () => {
      if (cancelled) return;
      attempt += 1;
      confirm.onRetry?.(attempt);
      proc.write("\r");
    };
    const tick = () => {
      if (cancelled) return;
      if (confirm.submitted()) { stopRetries(); return; }
      // Real work in flight: the prompt is queued, not lost. Hold the loop open
      // without spending an attempt — neither retrying nor reporting is correct
      // while the CLI is demonstrably busy.
      if (confirm.busy?.()) return;
      if (attempt >= maxAttempts) { stopRetries(); confirm.onUnconfirmed?.(attempt); return; }
      if (!confirm.abortSubmit) { sendCr(); return; }
      // Reading the screen is async, and the interval must not fire a CR while
      // the read is in flight (that CR is the thing being guarded against). Stop
      // the fixed cadence, check, then resume it. A skipped tick is harmless:
      // the loop is already inside its generous retry window.
      stopRetries();
      const resume = () => {
        if (cancelled) return;
        retryTimer = setInterval(tick, intervalMs);
        retryTimer.unref?.();
      };
      void confirm.abortSubmit().then((blocked) => {
        if (cancelled) return;
        if (blocked) { stopRetries(); confirm.onUnconfirmed?.(attempt); return; }
        // State can move during the read: a UserPromptSubmit that lands now
        // means the prompt is already in, and `busy` means real work is in
        // flight. Sending the CR either way types into a composer that may hold
        // the operator's own text, so re-check before writing.
        if (confirm.submitted()) { stopRetries(); return; }
        if (confirm.busy?.()) { resume(); return; }
        sendCr();
        resume();
      }).catch(() => {
        // The probe fails open itself (screenMatches swallows a read error), so
        // this is a contract backstop, not a second policy. Fall back to the
        // normal path rather than respawning on a screen we did not misread.
        if (cancelled) return;
        sendCr();
        resume();
      });
    };
    retryTimer = setInterval(tick, intervalMs);
    retryTimer.unref?.();
  };
  const submitTimer = setTimeout(() => {
    if (cancelled) return;
    // Re-check between the paste and the first CR: the menu can open in this
    // 150ms beat, and a CR at it confirms the rewind instead of the message.
    if (!confirm?.abortSubmit) {
      proc.write("\r");
      startRetries();
      return;
    }
    void confirm.abortSubmit().then((blocked) => {
      if (cancelled) return;
      if (blocked) { confirm.onUnconfirmed?.(0); return; }
      proc.write("\r");
      startRetries();
    }).catch(() => {
      // Same contract backstop as the retry tick: fail open, normal path.
      if (cancelled) return;
      proc.write("\r");
      startRetries();
    });
  }, 150);
  // Cancellation is not optional: a turn that settles for any other reason (user
  // interrupt, PTY death, engine switch) must stop this loop, or it would keep
  // writing CRs into a PTY that now belongs to a DIFFERENT turn — submitting
  // whatever that turn's composer happens to hold.
  return () => {
    cancelled = true;
    clearTimeout(submitTimer);
    stopRetries();
  };
}

export class InteractiveClaudeEngine implements InterruptibleEngine, PtyViewEngine {
  name = "claude" as const;
  /** Active turn resolvers keyed by Jinn session id. `boundProc` is the specific
   *  PTY serving this turn (captured at spawn / warm-reuse). A PTY's onExit only
   *  interrupts the active resolver when it IS that bound proc — so a stale PTY
   *  released by a kill->respawn race can't poison the freshly-started turn.
   *  `onStream` is the current turn's delta callback; the per-PTY SSE proxy routes
   *  parsed events here (a PTY outlives its turn, so the proxy looks this up live). */
  private active = new Map<string, ActiveTurn>();
  /** Sessions with an in-flight async idle-spawn (proxy.start awaited) — prevents
   *  a second ensureIdleSpawn from racing in a duplicate PTY during that gap. */
  private idleSpawning = new Set<string>();
  /** Per-session PTY output streams (scrollback ring buffer + live subscribers).
   *  Survives PTY respawn. */
  private streams: PtyStreamManager;
  /** Each PTY's newest raw output, kept for a start failure's message. */
  private readonly outputTails = new WeakMap<pty.IPty, { text: string }>();
  /** Last terminal geometry reported by the client per session. Used to spawn
   *  follow-up PTYs at the correct dimensions when a turn comes in after the
   *  warm PTY was reaped — otherwise spawn() falls back to 120×40 and the TUI
   *  text body is locked in at the wrong width. Intentionally survives PTY
   *  release (its job is to size the NEXT spawn); growth is bounded by setCapped. */
  private lastGeom = new Map<string, { cols: number; rows: number }>();
  private lastOutputAt = new Map<string, number>();
  /** sessions where Claude Code is running a background re-invocation
   *  that started while no gateway turn owned the session. Opened by its
   *  `<task-notification>` UserPromptSubmit, closed by the next Stop/StopFailure.
   *  While a turn runs, its resolver tracks this instead. */
  private backgroundReruns = new Set<string>();
  /** sessions with a turn typed into the terminal in progress, keyed to
   *  when it was seen starting. Opened by a UserPromptSubmit no gateway turn
   *  owns, closed by its Stop/StopFailure or by TERMINAL_TURN_QUIET_MS silence. */
  private terminalTurns = new Map<string, number>();
  /** Gateway turns waiting for a terminal turn to finish; calling it aborts. */
  private terminalWaits = new Map<string, (reason: string) => void>();
  private terminalWaitStartedAt = new Map<string, number>();
  private terminalWaitCb?: (sessionId: string, waiting: boolean) => void;
  /** Model/effort the live PTY was spawned with, per session. `--model`/`--effort`
   *  apply only at spawn, so a mid-chat switch must cold-respawn rather than reuse
   *  the warm PTY (which would keep running the old model). */
  private spawnParams = new Map<string, { model?: string; effortLevel?: string; appendApplied?: boolean }>();
  /** Sessions with a post-failure recovery listener armed (turn settled as an
   *  API error, but the CLI may still finish — a late Stop supersedes). */
  private lateRecovery = new Map<string, { timer: NodeJS.Timeout }>();
  /** Post-settle background work per session: the CLI's SSE proxy still has
   *  upstream requests in flight, or a background Bash monitor, background
   *  sub-agent or background re-run is open, after the Stop hook settled the
   *  turn. `emitted` tracks whether the gateway was told, so a cleared (null)
   *  notification is only sent when there's something to clear. */
  private bgActivity = new Map<string, {
    info: UpstreamActivityInfo;
    clearTimer?: NodeJS.Timeout;
    emitted: boolean;
    /** The last emission reported background sub-agents or a re-run. */
    emittedDiscreteWork?: boolean;
  }>();
  private backgroundMonitors = new Map<string, Set<string>>();
  /** Background sub-agents per session, by agent id: launched by a top-level
   *  Agent/Task call that returned async, ended by the task notification
   *  announcing them, a TaskStop, or a TaskOutput that found them finished. */
  private backgroundAgents = new Map<string, Set<string>>();
  private backgroundSilenceTimers = new Map<string, NodeJS.Timeout>();
  private backgroundActivityCb?: (jinnSessionId: string, info: UpstreamActivityInfo | null) => void;
  /** Test override for the post-settle clear quiet window (default 10s). */
  backgroundClearQuietMs = BACKGROUND_CLEAR_QUIET_MS;
  /** Test override for the background silence backstop (default 30m). */
  backgroundSilenceMs = BACKGROUND_SILENCE_MS;

  /** Answer Claude Code's hardcoded safety prompts automatically. On by default:
   *  a gateway PTY has no keyboard, so the alternative is a wedged session. Set
   *  `engines.claude.autoApproveSafetyPrompts: false` to leave them for a human
   *  in the CLI/xterm view instead — the turn then fails via the stall backstop
   *  rather than hanging, which is the other half of this fix. */
  private autoApproveSafetyPrompts: boolean;

  /** Live readers rather than captured values: config.yaml hot-reloads, and a
   *  remote block edited while the daemon runs must take effect on the next
   *  spawn rather than at the next restart. */
  private readRemoteConfig: () => RemoteExecutionConfig | undefined;
  private readGatewayPort: () => number;

  constructor(
    private lifecycle: PtyLifecycleManager,
    private hookRegistry: HookRegistry,
    opts: {
      autoApproveSafetyPrompts?: boolean;
      remote?: () => RemoteExecutionConfig | undefined;
      gatewayPort?: () => number;
    } = {},
  ) {
    this.autoApproveSafetyPrompts = opts.autoApproveSafetyPrompts ?? true;
    this.readRemoteConfig = opts.remote ?? (() => undefined);
    this.readGatewayPort = opts.gatewayPort ?? (() => 0);
    this.streams = new PtyStreamManager("PTY", (id) => this.lifecycle.getWarm(id) !== undefined);
    // Purge per-PTY bookkeeping whenever the session's PTY is released (kill,
    // LRU eviction, sweep reap, cold respawn) so these maps don't grow forever
    // in a long-running daemon. Both are meaningful only while a PTY is live and
    // are repopulated on the next spawn. lastGeom is NOT purged here — see above.
    // Every hook, claimed or not: notices turns typed into the terminal,
    // background re-invocations and the background tasks a turn launches.
    this.hookRegistry.tap?.((id, h) => this.observeHook(id, h));
    this.hookRegistry.tap?.((id, h) => this.observeBackgroundWork(id, h));
    this.lifecycle.onRelease((id) => {
      this.lastOutputAt.delete(id);
      this.terminalTurns.delete(id);
      this.backgroundReruns.delete(id);
      this.spawnParams.delete(id);
      // The PTY (and its SSE proxy) died — any in-flight counts are moot.
      this.clearBackground(id);
    });
  }

  /** Single-registration callback for post-settle background activity. `info` is
   *  the live in-flight snapshot; `null` means cleared (quiet for
   *  backgroundClearQuietMs, or the session's PTY was released). Never fires
   *  while a run() is in flight for the session — the turn is already "running";
   *  only post-settle activity matters. */
  onBackgroundActivity(cb: (jinnSessionId: string, info: UpstreamActivityInfo | null) => void): void {
    this.backgroundActivityCb = cb;
  }

  /**
   * Read the pending safety dialog off the terminal and answer it.
   *
   * Reading the screen (rather than trusting the hook) is the point: the
   * Notification payload says only "Claude needs your permission" — not which
   * dialog, nor what its options are. The parser refuses anything it does not
   * fully recognise, so an unfamiliar dialog stalls the turn instead of being
   * answered blind. `blockedOnPermissionAt` stays set on every failure path, so
   * whatever we decline to answer still reaches the stall backstop.
   */
  private async answerPermissionPrompt(sessionId: string, entry: ActiveTurn, attempt = 1): Promise<void> {
    if (!this.autoApproveSafetyPrompts) {
      logger.warn(
        `InteractiveClaudeEngine: ${sessionId} is blocked on a Claude Code safety prompt and `
        + `autoApproveSafetyPrompts is off — answer it in the CLI/xterm view or the turn will fail on the stall backstop.`,
      );
      return;
    }
    if (entry.approvingPermission && attempt === 1) return; // a retry owns the loop
    entry.approvingPermission = true;
    try {
      await delay(attempt === 1 ? PERMISSION_PROMPT_SETTLE_MS : PERMISSION_PROMPT_VERIFY_MS);
      if (entry.resolver.isSettled) return;

      const viewport = await this.streams.viewport(sessionId);
      if (!viewport) return;
      const prompt = parsePermissionPrompt(viewport);
      if (!prompt) {
        // Nothing recognisable on screen. Either it cleared (a human answered,
        // or the CLI withdrew it) or we caught a redraw — retry, then stop.
        if (attempt >= PERMISSION_PROMPT_MAX_ATTEMPTS) return;
        return await this.answerPermissionPrompt(sessionId, entry, attempt + 1);
      }

      const target = chooseApproval(prompt);
      if (!target) {
        logger.warn(
          `InteractiveClaudeEngine: ${sessionId} is blocked on a safety prompt with no unambiguous approval `
          + `option (${prompt.options.map((o) => o.label).join(" / ")}) — leaving it for a human.`,
        );
        return;
      }

      const proc = entry.boundProc;
      if (!proc) return;
      logger.warn(
        `InteractiveClaudeEngine: auto-approving Claude Code safety prompt for ${sessionId} `
        + `(attempt ${attempt}, reason: ${prompt.reason ?? "unstated"}, answering "${target.label}")`,
      );
      for (const key of keystrokesToSelect(prompt.selectedPosition, target.position)) proc.write(key);

      // Verify rather than assume. If the dialog is still up the keystrokes did
      // not land (TUI busy, mid-redraw) and the next attempt re-sends them.
      if (attempt < PERMISSION_PROMPT_MAX_ATTEMPTS) {
        return await this.answerPermissionPrompt(sessionId, entry, attempt + 1);
      }
      logger.warn(
        `InteractiveClaudeEngine: safety prompt for ${sessionId} still on screen after `
        + `${PERMISSION_PROMPT_MAX_ATTEMPTS} attempts — leaving it to the stall backstop.`,
      );
    } catch (err) {
      logger.warn(
        `InteractiveClaudeEngine: failed to auto-approve safety prompt for ${sessionId}: `
        + `${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      if (attempt === 1) entry.approvingPermission = false;
    }
  }

  onRuntimeActivity(cb: (jinnSessionId: string, info: UpstreamActivityInfo | null) => void): void {
    this.onBackgroundActivity(cb);
  }

  /** Per-PTY SSE proxy reported an in-flight change. Always record it (counts
   *  must stay truthful across the run boundary); emission is gated downstream. */
  private handleUpstreamActivity(jinnSessionId: string, info: UpstreamActivityInfo): void {
    const st = this.bgActivity.get(jinnSessionId);
    // A hook may have moved lastActivityAt past the proxy's own clock.
    const merged = { ...info, lastActivityAt: Math.max(info.lastActivityAt, st?.info.lastActivityAt ?? 0) };
    if (!st) this.bgActivity.set(jinnSessionId, { info: merged, emitted: false });
    else st.info = merged;
    this.maybeEmitBackground(jinnSessionId);
  }

  /** Track the installed Claude CLI's observed background-task lifecycle. A
   *  top-level PostToolUse Bash returns backgroundTaskId when launch succeeds,
   *  and a top-level Agent/Task call run in the background returns
   *  `status: "async_launched"` with its agentId (verified on 2.1.283). TaskStop
   *  PostToolUse carries the stopped id in tool_input when termination
   *  succeeds; TaskOutput reports a task's status when it is read. Background
   *  calls made inside Task subagents carry agent_id: the subagent waits on
   *  them itself, so they are not the session's. */
  private handleBackgroundMonitorHook(jinnSessionId: string, hook: HookPayload): void {
    if (hook.hook_event_name !== "PostToolUse") return;
    const input = hook.tool_input && typeof hook.tool_input === "object" && !Array.isArray(hook.tool_input)
      ? hook.tool_input as Record<string, unknown>
      : undefined;
    const response = hook.tool_response && typeof hook.tool_response === "object" && !Array.isArray(hook.tool_response)
      ? hook.tool_response as Record<string, unknown>
      : undefined;
    const topLevel = typeof hook.agent_id !== "string";

    if (
      hook.tool_name === "Bash"
      && topLevel
      && input?.run_in_background === true
      && typeof response?.backgroundTaskId === "string"
    ) {
      this.addBackgroundTask(this.backgroundMonitors, jinnSessionId, response.backgroundTaskId);
    } else if (
      (hook.tool_name === "Agent" || hook.tool_name === "Task")
      && topLevel
      && response?.status === "async_launched"
      && typeof response.agentId === "string"
    ) {
      this.addBackgroundTask(this.backgroundAgents, jinnSessionId, response.agentId);
    } else if (hook.tool_name === "TaskStop" && typeof input?.task_id === "string") {
      this.dropBackgroundMonitors(jinnSessionId, [input.task_id]);
    } else if (hook.tool_name === "TaskOutput") {
      // A task read to completion may never be announced by a notification.
      const task = response?.task && typeof response.task === "object" ? response.task as Record<string, unknown> : undefined;
      if (typeof task?.task_id === "string" && typeof task.status === "string" && !UNFINISHED_TASK_STATUSES.has(task.status)) {
        this.dropBackgroundMonitors(jinnSessionId, [task.task_id]);
      }
    }
  }

  private addBackgroundTask(tasks: Map<string, Set<string>>, jinnSessionId: string, taskId: string): void {
    const ids = tasks.get(jinnSessionId) ?? new Set<string>();
    if (ids.has(taskId)) return;
    ids.add(taskId);
    tasks.set(jinnSessionId, ids);
    this.publishBackgroundState(jinnSessionId);
  }

  /** Forget background tasks that ended — stopped with TaskStop, or finished on
   *  their own and announced by a task-notification. Covers background Bash
   *  tasks and background sub-agents alike; unknown ids (Monitors, tasks a
   *  subagent launched) are ignored. */
  private dropBackgroundMonitors(jinnSessionId: string, taskIds: string[]): void {
    let dropped = false;
    for (const tasks of [this.backgroundMonitors, this.backgroundAgents]) {
      const ids = tasks.get(jinnSessionId);
      if (!ids) continue;
      for (const taskId of taskIds) dropped = ids.delete(taskId) || dropped;
      if (ids.size === 0) tasks.delete(jinnSessionId);
    }
    if (dropped) this.publishBackgroundState(jinnSessionId);
  }

  /** A background-work fact changed (a task started or ended, a re-run opened
   *  or closed, a background hook arrived): record it as activity and re-emit. */
  private publishBackgroundState(jinnSessionId: string): void {
    const st = this.bgActivity.get(jinnSessionId);
    if (!st) {
      this.bgActivity.set(jinnSessionId, { info: { activeStreams: 0, activeAgents: 0, lastActivityAt: Date.now() }, emitted: false });
    } else {
      st.info = { ...st.info, lastActivityAt: Date.now() };
    }
    this.maybeEmitBackground(jinnSessionId);
  }

  /** The session's background state as reported: the proxy's in-flight counts
   *  plus what the hook stream says is still open. */
  private backgroundSnapshot(jinnSessionId: string, info: UpstreamActivityInfo): UpstreamActivityInfo {
    return {
      ...info,
      activeMonitors: this.backgroundMonitors.get(jinnSessionId)?.size ?? 0,
      backgroundAgents: this.backgroundAgents.get(jinnSessionId)?.size ?? 0,
      backgroundRerun: this.backgroundReruns.has(jinnSessionId),
    };
  }

  /** Emit the session's background state if it's post-settle and changed:
   *  any activity emits immediately (cancelling any pending clear); zero
   *  activity arms a quiet-window timer that emits `null` once, only if
   *  activity was previously reported. Suppressed while a run() is in flight. */
  private maybeEmitBackground(jinnSessionId: string): void {
    const st = this.bgActivity.get(jinnSessionId);
    if (!st) return;
    const info = this.backgroundSnapshot(jinnSessionId, st.info);
    const discreteWork = (info.backgroundAgents ?? 0) > 0 || info.backgroundRerun === true;
    // An open sub-agent or re-run keeps the PTY from being reaped as idle, as
    // an upstream request in flight does: either is work that dies with it.
    this.lifecycle.setRuntimeActive(jinnSessionId, info.activeStreams > 0 || discreteWork);
    this.armBackgroundSilence(jinnSessionId, discreteWork);
    if (this.active.has(jinnSessionId)) return; // in-flight turn — already "running"
    if (info.activeStreams > 0 || (info.activeMonitors ?? 0) > 0 || discreteWork) {
      if (st.clearTimer) { clearTimeout(st.clearTimer); st.clearTimer = undefined; }
      st.emitted = true;
      st.emittedDiscreteWork = discreteWork;
      this.backgroundActivityCb?.(jinnSessionId, info);
      return;
    }
    if (!st.emitted) {
      // Reached 0 without ever being reported post-settle — nothing to clear.
      this.bgActivity.delete(jinnSessionId);
      return;
    }
    if (st.emittedDiscreteWork) {
      // The sub-agents and the re-run they woke are done. Say so now, not at
      // the end of the quiet window: a parent woken by the re-run's reply reads
      // this session next, and must not find it still running.
      st.emittedDiscreteWork = false;
      this.backgroundActivityCb?.(jinnSessionId, info);
    }
    if (st.clearTimer) return; // quiet window already armed
    st.clearTimer = setTimeout(() => {
      const cur = this.bgActivity.get(jinnSessionId);
      if (cur !== st) return; // state was recreated/cleared since arming
      cur.clearTimer = undefined;
      const now = this.backgroundSnapshot(jinnSessionId, cur.info);
      if (now.activeStreams > 0 || (now.activeMonitors ?? 0) > 0 || (now.backgroundAgents ?? 0) > 0 || now.backgroundRerun) return;
      this.bgActivity.delete(jinnSessionId);
      this.backgroundActivityCb?.(jinnSessionId, null);
    }, this.backgroundClearQuietMs);
    st.clearTimer.unref?.();
  }

  /** (Re)arm the silence backstop while sub-agents or a re-run are open; every
   *  sign of life passes through maybeEmitBackground and pushes it back. */
  private armBackgroundSilence(jinnSessionId: string, discreteWork: boolean): void {
    const prior = this.backgroundSilenceTimers.get(jinnSessionId);
    if (prior) clearTimeout(prior);
    this.backgroundSilenceTimers.delete(jinnSessionId);
    if (!discreteWork) return;
    const timer = setTimeout(() => {
      this.backgroundSilenceTimers.delete(jinnSessionId);
      if (this.active.has(jinnSessionId)) return; // the turn's end re-arms it
      const st = this.bgActivity.get(jinnSessionId);
      if (st && st.info.activeStreams > 0) {
        this.armBackgroundSilence(jinnSessionId, true); // a request in flight is a sign of life
        return;
      }
      logger.warn(
        `InteractiveClaudeEngine: ${jinnSessionId} background work (${this.backgroundAgents.get(jinnSessionId)?.size ?? 0} sub-agent(s)`
        + `${this.backgroundReruns.has(jinnSessionId) ? ", a re-run" : ""}) silent for ${Math.round(this.backgroundSilenceMs / 60_000)}m `
        + `with no end reported — no longer counting it as running`,
      );
      this.backgroundAgents.delete(jinnSessionId);
      this.backgroundReruns.delete(jinnSessionId);
      this.publishBackgroundState(jinnSessionId);
    }, this.backgroundSilenceMs);
    timer.unref?.();
    this.backgroundSilenceTimers.set(jinnSessionId, timer);
  }

  /** A new run() is taking the session: retract any reported background state
   *  (the session is about to be "running") but KEEP the live counts — the proxy
   *  persists across turns, and run()'s finally re-checks them post-settle. */
  private suppressBackground(jinnSessionId: string): void {
    const st = this.bgActivity.get(jinnSessionId);
    if (!st) return;
    if (st.clearTimer) { clearTimeout(st.clearTimer); st.clearTimer = undefined; }
    const wasEmitted = st.emitted;
    st.emitted = false;
    st.emittedDiscreteWork = false;
    if (wasEmitted) this.backgroundActivityCb?.(jinnSessionId, null);
  }

  /** Drop all background state for a session (PTY released / killed), emitting
   *  the cleared notification if activity had been reported. */
  private clearBackground(jinnSessionId: string): void {
    this.lifecycle.setRuntimeActive(jinnSessionId, false);
    this.backgroundMonitors.delete(jinnSessionId);
    this.backgroundAgents.delete(jinnSessionId);
    const silence = this.backgroundSilenceTimers.get(jinnSessionId);
    if (silence) clearTimeout(silence);
    this.backgroundSilenceTimers.delete(jinnSessionId);
    const st = this.bgActivity.get(jinnSessionId);
    if (!st) return;
    if (st.clearTimer) clearTimeout(st.clearTimer);
    this.bgActivity.delete(jinnSessionId);
    if (st.emitted) this.backgroundActivityCb?.(jinnSessionId, null);
  }

  private hasActiveUpstream(jinnSessionId: string): boolean {
    return (this.bgActivity.get(jinnSessionId)?.info.activeStreams ?? 0) > 0;
  }

  /** Track background work from the hook stream: background tasks launched
   *  and ended at any time, and — while no gateway turn owns the session (a
   *  running turn's resolver does this for itself) — background
   *  re-invocations. A hook from a sub-agent or from an open re-run is a sign
   *  the session is working, so it counts as activity. */
  private observeBackgroundWork(jinnSessionId: string, h: HookPayload): void {
    this.handleBackgroundMonitorHook(jinnSessionId, h);
    // The re-run a notification opens is the announcement that its tasks ended.
    if (isBackgroundReinvocation(h)) this.dropBackgroundMonitors(jinnSessionId, finishedTaskNotificationIds(String(h.prompt)));
    if (this.active.has(jinnSessionId)) return;
    const rerunWasOpen = this.backgroundReruns.has(jinnSessionId);
    // A notification folded into a typed turn is taken for a re-run too: a
    // typed prompt that is only queued also counts as "open" (its
    // UserPromptSubmit fires at once), so being open does not show it is the
    // one running. The cost is that turn's Stop being read as the re-run's,
    // and the next gateway turn waiting out the quiet backstop (F6).
    if (isBackgroundReinvocation(h)) this.backgroundReruns.add(jinnSessionId);
    else if (endsTurn(h)) this.backgroundReruns.delete(jinnSessionId);
    if (rerunWasOpen || this.backgroundReruns.has(jinnSessionId) || typeof h.agent_id === "string") {
      this.publishBackgroundState(jinnSessionId);
    }
  }

  /**
   * Hold a warm-PTY turn's paste behind a background re-invocation, then
   * behind any turn the operator typed into the terminal meanwhile (observeHook
   * tracks those while the paste is held); either can start while the other is
   * waited out. Stop, a new message or "send now" during
   * the typed-turn wait end only that wait (see kill()).
   */
  private async holdPaste(jinnSessionId: string, handle: PtyHandle, entry: ActiveTurn): Promise<void> {
    const { resolver } = entry;
    entry.holdingPaste = true;
    try {
      while (!resolver.isSettled) {
        if (resolver.awaitingBackgroundRerun) {
          await this.waitForBackgroundRerun(jinnSessionId, handle, entry);
          continue;
        }
        if (!this.terminalTurns.has(jinnSessionId)) return;
        const waitAbort = await this.waitForTerminalTurn(jinnSessionId, resolver);
        if (waitAbort !== undefined && !resolver.isSettled) {
          resolver.interrupt(waitAbort.startsWith("Interrupted") ? waitAbort : `Interrupted: ${waitAbort}`);
        }
      }
    } finally {
      entry.holdingPaste = false;
    }
  }

  /**
   * Hold a warm-PTY turn's paste until the background re-invocation running
   * ahead of it has finished. A prompt pasted into a re-run is queued
   * behind it, or folded into it at the next tool boundary; folded, it gets no
   * reply of its own, only the re-run's. The resolver attributes the re-run's
   * Stop either way; waiting is what keeps the prompt a turn of its own.
   *
   * Ends when the re-run's Stop has arrived and BACKGROUND_RERUN_SETTLE_MS have
   * passed without another starting (Claude Code dequeues a further
   * notification tens of ms after a Stop), when the turn settles (an
   * interrupt), when the PTY is gone, or, if the Stop was lost, once Claude
   * Code has been quiet for BACKGROUND_RERUN_QUIET_MS with nothing in flight.
   * A re-run that goes silent mid-work (a tool left running, a dialog) meets
   * the same stall verdict a running turn would.
   */
  private waitForBackgroundRerun(jinnSessionId: string, handle: PtyHandle, entry: ActiveTurn): Promise<void> {
    const { resolver } = entry;
    logger.info(`InteractiveClaudeEngine: ${jinnSessionId} is running a background re-invocation — holding the gateway turn's prompt until it finishes`);
    const startedAt = Date.now();
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        const now = Date.now();
        if (resolver.isSettled || this.lifecycle.getWarm(jinnSessionId) !== handle) return done();
        if (!resolver.awaitingBackgroundRerun) {
          if (now - (resolver.backgroundRerunEndedAt ?? 0) >= BACKGROUND_RERUN_SETTLE_MS) done();
          return;
        }
        const quietFor = now - Math.max(startedAt, entry.lastHookAt, this.lastOutputAt.get(jinnSessionId) ?? 0);
        if (quietFor >= BACKGROUND_RERUN_QUIET_MS && entry.activeTools === 0 && !this.hasActiveUpstream(jinnSessionId)) {
          logger.warn(`InteractiveClaudeEngine: background re-invocation for ${jinnSessionId} went quiet without a Stop — taking it as finished`);
          resolver.abandonBackgroundRerun();
          return done();
        }
        if (shouldSettleStalledTurn(now - startedAt, quietFor)) {
          resolver.interrupt("Turn stalled: a background re-invocation the prompt was waiting behind never finished");
          return done();
        }
      }, BACKGROUND_RERUN_POLL_MS);
      timer.unref?.();
      // An interrupt ends the wait at once, not on the next poll.
      void resolver.promise.then(done);
      function done() {
        clearInterval(timer);
        resolve();
      }
    });
  }

  /**
   * Deliver a pasted prompt that the warm PTY never took, by respawning the
   * session with it in argv (JIN-3).
   *
   * This is the cold path run() already takes when a warm PTY cannot serve a
   * turn (a model switch, a PTY born without the persona): `--resume` keeps the
   * conversation, and a prompt in argv is submitted by construction, whatever
   * state the old TUI was left in. It is also what an operator's resend did —
   * interrupting the stuck turn got the message through.
   *
   * Only for a prompt that provably never arrived: no UserPromptSubmit of ours,
   * and, where the transcript is on this machine, no copy of the prompt in it
   * since the paste. A prompt that did arrive with its hook lost would otherwise
   * run twice. A turn stopped while this runs spawns and stages nothing.
   */
  private async redeliverByRespawn(
    jinnSessionId: string,
    entry: ActiveTurn,
    opts: EngineRunOpts,
    pastedAt: number,
    registerTurnHooks: () => void,
  ): Promise<void> {
    const { resolver } = entry;
    if (resolver.isSettled || resolver.promptSubmittedAt !== undefined) return;
    if (!isRemoteTarget(opts)) {
      const sid = resolver.sessionId ?? opts.resumeSessionId;
      const transcript = sid ? findSessionTranscript(sid, opts.claudeProfile) : undefined;
      if (transcript && transcriptHasPromptSince(transcript, pastedAt, opts.prompt)) {
        logger.warn(`InteractiveClaudeEngine: ${jinnSessionId}'s transcript has the prompt though no hook said so — not respawning, which would run it twice. Leaving the turn to the stall backstop.`);
        return;
      }
    }
    // A remote transcript is on the other host, so there the hook is the only
    // evidence: a remote prompt whose UserPromptSubmit hook was lost in transit
    // would run twice. Accepted — a lost hook already breaks that turn's Stop.

    // Unbind first: the old PTY's exit must not interrupt the turn the new one
    // is about to serve (wireProcToStream's identity guard, and the watchdog).
    entry.boundProc = undefined;
    // Its cleanup deletes the settings and MCP files and drops the turn's hook
    // registration; all three are restored below before anything can fire.
    this.lifecycle.releaseSession(jinnSessionId);
    registerTurnHooks();

    let handle: PtyHandle | undefined;
    try {
      const settingsPath = writeClaudeSessionSettings(jinnSessionId, opts.claudeProfile);
      if (opts.resolvedMcp && !isRemoteTarget(opts)) {
        opts.mcpConfigPath = writeMcpConfigFile(opts.resolvedMcp, jinnSessionId);
      }
      // Stopped while this ran: spawn nothing — above all, stage nothing on a
      // remote host, where staging repoints the session's hook relay at a
      // tunnel only this spawn would open (see prepareRemote). The lifecycle
      // may already hold the next turn's PTY.
      // Before the spawn, so a SessionStart from the new process cannot land
      // ahead of it: the old process's start says nothing about this one's.
      resolver.newProcess();
      handle = await this.spawn(jinnSessionId, opts, settingsPath, () => resolver.isSettled);
    } catch (err) {
      // Not "Interrupted:" — that reads as a quiet stop downstream, and an
      // undelivered message has to surface.
      resolver.interrupt(`Prompt not delivered: Claude Code did not take it, and respawning failed (${err instanceof Error ? err.message : String(err)})`);
      return;
    }
    if (!handle) return;
    if (resolver.isSettled) {
      // Settled between the spawn and here. Kill only our own PTY.
      handle.kill("SIGTERM");
      return;
    }
    this.lifecycle.adopt(jinnSessionId, handle, { turnRunning: true });
    this.lifecycle.turnStarted(jinnSessionId);
    entry.boundProc = (handle as any)._proc as pty.IPty | undefined;
    entry.promptSubmitted = true;
  }

  /** Track turns typed into the terminal from the hook stream. */
  private observeHook(jinnSessionId: string, h: HookPayload): void {
    if (isBackgroundReinvocation(h)) return;
    const event = h.hook_event_name;
    const entry = this.active.get(jinnSessionId);
    // No gateway turn, or one whose paste is still held: a prompt
    // submitted now was typed into the terminal.
    if (!entry || entry.holdingPaste) {
      if (event === "UserPromptSubmit") this.terminalTurns.set(jinnSessionId, Date.now());
      else if (event === "Stop" || event === "StopFailure") {
        // A background re-run's Stop ends the re-run, not a typed turn queued
        // behind it. Taps run before the turn's listener, so both checks still
        // see the re-run as open when its own Stop arrives.
        const rerunOpen = entry ? entry.resolver.awaitingBackgroundRerun : this.backgroundReruns.has(jinnSessionId);
        if (!rerunOpen) this.terminalTurns.delete(jinnSessionId);
      }
      return;
    }
    // A gateway turn owns the session: every UserPromptSubmit beyond its own is
    // somebody typing in the terminal — cold spawn, warm paste or native
    // command alike.
    if (event === "UserPromptSubmit") {
      entry.promptSubmitsSeen = (entry.promptSubmitsSeen ?? 0) + 1;
      if (entry.promptSubmitsSeen > (entry.native ? 0 : 1)) entry.terminalPromptQueued = true;
    }
  }

  /** True while one of Claude Code's safety prompts sits at the bottom of the
   *  screen waiting on the operator: silent, but the turn is not over — and it
   *  is not the gateway's to answer or paste into. Conversation text that
   *  merely quotes a dialog does not count (viewportShowsLiveSafetyPrompt). */
  private async screenShowsSafetyPrompt(jinnSessionId: string): Promise<boolean> {
    return this.screenMatches(jinnSessionId, viewportShowsLiveSafetyPrompt);
  }

  /** True while Claude Code's Esc Esc Rewind flow owns the screen — either the
   *  rewind list or the restore-confirm dialog Enter opens. The gateway must not
   *  paste into it, or a CR would confirm the rewind (*  viewportShowsRewindMenu). */
  private async screenShowsRewindMenu(jinnSessionId: string): Promise<boolean> {
    return this.screenMatches(jinnSessionId, viewportShowsRewindMenu);
  }

  /** Read the session's visible rows and run a dialog detector over them. Fails
   *  OPEN: false when there is no snapshot or the read throws, so the caller's
   *  normal path runs. That is deliberate for the Rewind guard too — a warm turn
   *  with no snapshot must still send its prompt; the cost of a missed menu is
   *  carried by the pre-paste and per-CR re-checks, not by respawning every
   *  snapshotless turn. */
  private async screenMatches(
    jinnSessionId: string,
    detect: (viewport: readonly string[]) => boolean,
  ): Promise<boolean> {
    try {
      const viewport = await this.streams.viewport(jinnSessionId);
      return viewport ? detect(viewport) : false;
    } catch {
      return false;
    }
  }

  /**
   * Hold a gateway turn until a turn typed into the terminal has finished.
   *
   * Claude Code queues a prompt pasted while a turn runs, and fires that
   * prompt's UserPromptSubmit at once rather than when it runs (verified on
   * 2.1.283). So once pasted, nothing in the hook stream says which Stop is
   * whose: the gateway turn would record the operator's answer as its reply. At
   * a tool boundary Claude Code instead folds the queued prompt into the running
   * turn, merging two turns into one. Waiting until the terminal turn is over
   * avoids both, and keeps the operator's turn separate so the external-turn
   * sync records it. Returns an abort reason if the turn was interrupted.
   */
  private waitForTerminalTurn(jinnSessionId: string, resolver?: TurnResolver): Promise<string | undefined> {
    if (!this.terminalTurns.has(jinnSessionId)) return Promise.resolve(undefined);
    logger.info(`InteractiveClaudeEngine: ${jinnSessionId} has a turn typed in the terminal in progress — holding the gateway turn until it finishes`);
    const startedAt = Date.now();
    let nextLogAt = startedAt + TERMINAL_TURN_LOG_EVERY_MS;
    let checking = false;
    return new Promise((resolve) => {
      let done = false;
      const finish = (reason?: string) => {
        if (done) return;
        done = true;
        clearInterval(timer);
        this.terminalWaits.delete(jinnSessionId);
        this.terminalWaitStartedAt.delete(jinnSessionId);
        this.terminalWaitCb?.(jinnSessionId, false);
        resolve(reason);
      };
      const timer = setInterval(() => {
        if (done || checking) return;
        const openedAt = this.terminalTurns.get(jinnSessionId);
        if (openedAt === undefined) return finish();
        if (!this.lifecycle.getWarm(jinnSessionId)) {
          this.terminalTurns.delete(jinnSessionId);
          return finish();
        }
        const now = Date.now();
        if (now >= nextLogAt) {
          nextLogAt = now + TERMINAL_TURN_LOG_EVERY_MS;
          logger.info(`InteractiveClaudeEngine: ${jinnSessionId} still waiting for the terminal turn (${Math.round((now - startedAt) / 60_000)}m)`);
        }
        const lastSign = Math.max(openedAt, this.lastOutputAt.get(jinnSessionId) ?? 0);
        if (now - lastSign < TERMINAL_TURN_QUIET_MS) return;
        if (this.hasActiveUpstream(jinnSessionId)) return;
        // Silent and no request in flight: confirm on screen before calling it over.
        checking = true;
        void this.screenShowsSafetyPrompt(jinnSessionId).then((working) => {
          checking = false;
          if (done || working) return;
          if (this.terminalTurns.get(jinnSessionId) !== openedAt) return; // a new turn started meanwhile
          this.terminalTurns.delete(jinnSessionId);
          finish();
        });
      }, TERMINAL_TURN_POLL_MS);
      timer.unref?.();
      this.terminalWaits.set(jinnSessionId, (reason) => finish(reason));
      this.terminalWaitStartedAt.set(jinnSessionId, startedAt);
      this.terminalWaitCb?.(jinnSessionId, true);
      // A registered turn held behind the terminal turn can also be
      // settled from elsewhere (a teardown, the PTY dying).
      void resolver?.promise.then(() => finish());
    });
  }

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    const jinnSessionId = opts.sessionId;
    if (!jinnSessionId) throw new Error("InteractiveClaudeEngine.run requires opts.sessionId");

    // Guard: refuse a second concurrent turn for the same session (one still
    // waiting behind a terminal turn counts).
    if (this.active.has(jinnSessionId) || this.terminalWaits.has(jinnSessionId)) {
      return { sessionId: opts.resumeSessionId ?? "", result: "", error: "Interactive engine: a turn is already running for this session" };
    }

    // Before anything that could touch the PTY — including the cold respawn
    // below, which would kill the operator's turn outright. Awaited only when
    // there is something to wait for, so a session nobody typed into runs
    // exactly as before, without even a microtask of delay.
    if (this.terminalTurns.has(jinnSessionId)) {
      const waitAbort = await this.waitForTerminalTurn(jinnSessionId);
      if (waitAbort !== undefined) {
        // An interrupt keeps its "Interrupted…" reason; the wait's own timeout
        // is a real, visible error.
        const error = waitAbort.startsWith("Interrupted") ? waitAbort : `Interrupted: ${waitAbort}`;
        return { sessionId: opts.resumeSessionId ?? "", result: "", error };
      }
    }
    const turnStartedAt = Date.now();

    if (this.active.has(jinnSessionId)) {
      return { sessionId: opts.resumeSessionId ?? "", result: "", error: "Interactive engine: a turn is already running for this session" };
    }

    // A previous turn may have left a late-recovery listener armed; this new
    // turn owns the session (and the hook registration) now.
    this.cancelLateRecovery(jinnSessionId);
    // Retract any reported post-settle background activity — the session is
    // about to be "running", which supersedes the background indicator.
    this.suppressBackground(jinnSessionId);

    let warm = this.lifecycle.getWarm(jinnSessionId);
    // Mid-chat model/effort switch: `--model`/`--effort` bind at spawn, so a warm
    // PTY would silently keep the OLD model. If the request differs from what this
    // PTY was spawned with, drop the warm PTY and cold-respawn (--resume keeps the
    // conversation) so the new model/effort actually takes effect.
    if (warm) {
      const prev = this.spawnParams.get(jinnSessionId);
      const norm = (v?: string) => (!v || v === "default" ? "" : v);
      const modelOrEffortChanged =
        !!prev && (norm(opts.model) !== norm(prev.model) || norm(opts.effortLevel) !== norm(prev.effortLevel));
      // Idle-spawned PTYs (terminal view) are born WITHOUT --append-system-prompt, so
      // they carry neither the persona/org context nor the main-agent sentinel. Force a
      // cold respawn on the first real turn so it runs on-persona AND streams to the
      // chat pane (the sentinel is what makes the SSE proxy tee). --resume preserves
      // the conversation.
      const missingPrompt = !prev || prev.appendApplied !== true;
      if (modelOrEffortChanged || missingPrompt) {
        logger.info(`InteractiveClaudeEngine: cold respawn for ${jinnSessionId} (${modelOrEffortChanged ? "model/effort changed" : "warm PTY missing --append-system-prompt"})`);
        this.lifecycle.releaseSession(jinnSessionId);
        warm = undefined;
      }
    }

    // Write the per-turn --settings file AFTER any cold-respawn release above:
    // releaseSession() fires onCleanup → cleanupSessionSettings(), which DELETES this
    // exact file. Writing it earlier meant the model/effort cold-respawn spawned
    // `claude --settings <file>` against a file we'd just unlinked → the CLI/xterm
    // view showed "Settings file not found". The settings file carries HOOKS only; the
    // system prompt + main-agent sentinel go via the --append-system-prompt CLI flag at
    // spawn() (the settings-file appendSystemPrompt KEY is ignored by claude ≥2.1.x).
    const settingsPath = writeClaudeSessionSettings(jinnSessionId, opts.claudeProfile);
    // A cold-respawn release cleans the per-session MCP file. Materialize the
    // already-resolved config again at the boundary where Claude will read it.
    // A remote session gets its MCP config staged on the other host instead
    // (remapped for that install's node and entrypoints), so materializing the
    // gateway-local file here would only write a config naming paths the remote
    // claude cannot open — and it would carry any MCP server API keys with it.
    if (!warm && opts.resolvedMcp && !isRemoteTarget(opts)) {
      opts.mcpConfigPath = writeMcpConfigFile(opts.resolvedMcp, jinnSessionId);
    }
    const nativeCommand = isNativeClaudeCommand(opts.prompt);
    const compactCommand = nativeCommand && isCompactCommand(opts.prompt);
    // A warm PTY is one the operator may be typing into: our pasted
    // prompt can queue behind a turn of theirs. Native commands fire no
    // UserPromptSubmit, and a cold spawn carries the prompt in argv into a
    // process nobody has touched, so neither needs the gate.
    const gateOnPromptSubmit = !!warm && !nativeCommand;
    // A background re-invocation Claude Code started on its own is running in
    // this PTY: its Stop is not ours. The resolver tracks it from here.
    const backgroundRerunInProgress = !!warm && this.backgroundReruns.has(jinnSessionId);
    this.backgroundReruns.delete(jinnSessionId);
    const resolver = new TurnResolver({
      fallbackSessionId: opts.resumeSessionId,
      assumeStarted: !!warm, // warm PTY = SessionStart already fired (turn 1 or idle spawn)
      native: nativeCommand,
      shouldDeferStopFailure: () => this.hasActiveUpstream(jinnSessionId),
      requireLivePromptSubmit: gateOnPromptSubmit,
      backgroundRerunInProgress,
      ownPromptAfterPaste: !!warm,
      onForeignStop: (h) => {
        logger.info(`InteractiveClaudeEngine: Stop for ${jinnSessionId} belongs to a turn the gateway turn does not own (typed in the terminal, or a background re-invocation) — syncing it as an external turn`);
        this.hookRegistry.consumeAsUnclaimed?.(jinnSessionId, h);
      },
    });
    const entry: ActiveTurn = {
      resolver,
      onStream: opts.onStream,
      activeTools: 0,
      startedAt: turnStartedAt,
      lastHookAt: turnStartedAt,
      gated: gateOnPromptSubmit,
      native: nativeCommand,
      // Only the warm-PTY paste has to earn this flag. The cold-spawn path carries
      // the prompt in argv, so it is submitted by construction; native commands are
      // exempt because no acknowledgement is expected for them (see injectPrompt
      // below) and awaitingSubmit must not mean "waiting for a signal we never want".
      promptSubmitted: !warm || nativeCommand,
    };
    let turnMarkedStarted = false;
    // Transcript text before this is not this turn's: it moves past a wait for
    // a background re-invocation.
    let promptWrittenAt = turnStartedAt;
    let watchdog: NodeJS.Timeout | undefined;
    let nativeCommandTimer: NodeJS.Timeout | undefined;
    /** The PostCompact that ended a `/compact` turn: proof it compacted. */
    let compactedBy: HookPayload | undefined;
    let lostStopRecoveryTimer: NodeJS.Timeout | undefined;

    let result!: EngineResult;
    this.active.set(jinnSessionId, entry);
    try {
      // Register BEFORE spawning so a fast SessionStart is buffered+drained, not lost.
      // register() drains the buffer synchronously, so everything delivered
      // while `replaying` is true predates this turn.
      let replaying = true;
      const onTurnHook = (h: HookPayload) => {
        // A foreign hook belongs to a background re-invocation: it
        // must not acknowledge, stream into or settle this turn.
        const foreign = resolver.onHook(h, { replayed: replaying }) === "foreign";
        // `/compact` is done when Claude Code says so. A replayed PostCompact
        // predates this turn, and an auto-compaction is not the one asked for.
        if (compactCommand && !replaying && h.hook_event_name === "PostCompact" && h.trigger !== "auto") {
          compactedBy = h;
          resolver.completeNativeCommand();
        }
        entry.lastHookAt = Date.now();
        // Submit acknowledgement. UserPromptSubmit is the direct signal; the in-turn
        // hooks are accepted too because none of them can fire before a prompt is
        // running. SessionStart is deliberately NOT accepted — it can arrive from the
        // idle spawn that preceded this turn and would falsely confirm the submit.
        // Under the warm-PTY gate only our own live UserPromptSubmit counts: a
        // turn typed in the terminal fires the in-turn hooks too, and taking
        // those as our acknowledgement would stop the CR retries for a prompt
        // that is still sitting in the composer.
        // While the paste is held nothing is ours yet: whatever runs is a
        // background re-run or a turn typed into the terminal.
        const held = entry.holdingPaste === true;
        if (!foreign && !held && (gateOnPromptSubmit
          ? h.hook_event_name === "UserPromptSubmit" && !replaying
          : SUBMIT_ACK_HOOKS.has(h.hook_event_name))) {
          entry.promptSubmitted = true;
        }
        // tool_use markers + intermediate text stream from the per-PTY SSE proxy
        // in true order. The hooks supply tool_result (SSE has no local tool
        // completion event because tools execute between assistant messages) and
        // the tool_use of every call the proxy does not see (see claudeHookToDeltas).
        if (h.hook_event_name === "PreToolUse") {
          entry.activeTools += 1;
        }
        if (h.hook_event_name === "PostToolUse") {
          entry.activeTools = Math.max(0, entry.activeTools - 1);
          // The tool ran, so whatever prompt was gating it is gone — whether we
          // answered it or a human did in the CLI/xterm view.
          entry.blockedOnPermissionAt = undefined;
        }
        // A replayed PreToolUse predates this turn: its call, if it was ours,
        // was reported by the turn that made it.
        const toolHook = h.hook_event_name === "PostToolUse" || (h.hook_event_name === "PreToolUse" && !replaying);
        if (toolHook && !foreign && !held) {
          for (const delta of claudeHookToDeltas(h as Record<string, unknown>)) this.forwardDelta(entry, delta);
        }
        // Only a prompt of this turn's own. A replayed one predates the turn,
        // and before our UserPromptSubmit a gated turn's prompts belong to
        // whoever typed in the terminal — the operator answers those.
        // A background re-invocation's prompts have nobody at the terminal to
        // answer them: while one runs ahead of this turn, answer them.
        // While the paste is held, only a background re-run's: a typed turn's
        // prompts are the operator's to answer. With a typed turn open, a
        // notification folded into it looks exactly like a re-run ahead, so
        // leave the dialog to the operator — they are at the terminal.
        if (isPermissionPromptNotification(h) && !replaying
          && (held
            ? resolver.awaitingBackgroundRerun && !this.terminalTurns.has(jinnSessionId)
            : !gateOnPromptSubmit || resolver.promptSubmittedAt !== undefined || resolver.awaitingBackgroundRerun)) {
          entry.blockedOnPermissionAt = Date.now();
          void this.answerPermissionPrompt(jinnSessionId, entry);
        }
      };
      const registerTurnHooks = () => {
        replaying = true;
        this.hookRegistry.register(jinnSessionId, onTurnHook);
        replaying = false;
      };
      registerTurnHooks();

      if (warm) {
        // Mark the turn started BEFORE injecting so the sweep timer can't
        // theoretically release the PTY mid-paste if its grace window expired
        // between getWarm() above and the proc.write() inside injectPrompt.
        this.lifecycle.turnStarted(jinnSessionId);
        turnMarkedStarted = true;
        entry.boundProc = (warm as any)._proc as pty.IPty | undefined;
        if (resolver.awaitingBackgroundRerun) {
          await this.holdPaste(jinnSessionId, warm, entry);
          promptWrittenAt = Date.now();
        }
        if (!resolver.isSettled) {
          resolver.promptWritten();
          // Tools and dialogs counted while the paste was held were other
          // turns' (the hold kept them to gate its quiet backstop); a tool the
          // operator interrupted never fires PostToolUse, and would otherwise
          // pin this turn "busy" for good.
          entry.activeTools = 0;
          entry.blockedOnPermissionAt = undefined;
        }
        // a live Esc Esc Rewind menu owns the composer. Claude Code
        // drops the paste whole and takes the submit CR as "Enter to continue",
        // confirming the highlighted rewind — and any restore dialog after it —
        // while our message is lost. Deliver by respawn (JIN-3's path) instead,
        // which puts the prompt in argv and never emits a CR at the menu.
        // Checked after promptWritten() so the respawned turn's own
        // UserPromptSubmit is still recognised as ours.
        if (!resolver.isSettled && (await this.screenShowsRewindMenu(jinnSessionId))) {
          logger.warn(
            `InteractiveClaudeEngine: Rewind menu is open for ${jinnSessionId}; `
            + `skipping the warm-PTY paste and respawning to deliver the prompt.`,
          );
          await this.redeliverByRespawn(jinnSessionId, entry, opts, promptWrittenAt, registerTurnHooks);
        } else {
          // Native commands (/compact, /clear, /model) run locally and settle via
          // nativeCommandTimer; they need not emit UserPromptSubmit at all. Their
          // one submit CR is still a CR, though, so it is screen-gated like any
          // other. `submitted` is already true for them, which stops
          // the confirmation loop on its first tick rather than re-sending CRs
          // at a prompt that already did its work — the exclusion the lost-Stop
          // recovery below makes, for the same reason.
          entry.cancelSubmitConfirm = resolver.isSettled ? undefined : this.injectPrompt(warm, opts, jinnSessionId, {
            // A settled turn is no longer ours to submit — stop either way. Without
            // this the loop would outlive an early interrupt until run()'s finally.
            submitted: () => nativeCommand || entry.promptSubmitted || resolver.isSettled,
            // Claude Code queues a pasted prompt behind a turn already running
            // (its UserPromptSubmit fires at once on 2.1.283), and a busy TUI can
            // drop the CR. Pause on any evidence of real work rather than
            // re-sending into that ambiguity.
            busy: () => this.hasActiveUpstream(jinnSessionId) || entry.activeTools > 0,
            // The Rewind menu can open after the pre-paste check above — in the
            // 150ms before the first CR, or between retries. Every CR is gated on
            // the screen, so one is never written at the menu.
            abortSubmit: () => this.screenShowsRewindMenu(jinnSessionId),
            onRetry: (attempt) => logger.warn(
              `InteractiveClaudeEngine: prompt submit unacknowledged for ${jinnSessionId} — re-sending CR (attempt ${attempt})`,
            ),
            // Never settle here: the turn is not dead, its prompt just never got
            // in. Claude Code's TUI can swallow a paste whole — the Esc Esc rewind
            // menu takes the CR as "continue" and the text vanishes, and the ctrl+o
            // transcript view and a ctrl+z suspend eat both (JIN-3). The operator
            // saw the message sent and nothing happen. Deliver it the way a cold
            // turn does instead: respawn with the prompt in argv.
            onUnconfirmed: (attempts) => {
              logger.warn(
                `InteractiveClaudeEngine: prompt still unacknowledged for ${jinnSessionId} after ${attempts} re-sent CRs; `
                + `Claude Code never took the paste. Respawning the session to deliver it.`,
              );
              void this.redeliverByRespawn(jinnSessionId, entry, opts, promptWrittenAt, registerTurnHooks);
            },
          });
        }
      } else {
        const handle = await this.spawn(jinnSessionId, opts, settingsPath);
        this.lifecycle.adopt(jinnSessionId, handle, { turnRunning: true });
        this.lifecycle.turnStarted(jinnSessionId);
        turnMarkedStarted = true;
        entry.boundProc = (handle as any)._proc as pty.IPty | undefined;
      }

      // Watchdog: if the bound PTY dies without the resolver settling (e.g. the
      // onExit identity-guard didn't match in a kill→respawn race), the turn would
      // hang forever — runWebSession's 5s heartbeat would zombie status:"running"
      // and the completion (session:completed + notifyParentSession parent callback)
      // would never fire. Both the stuck "in progress" badge and lost child-session
      // callbacks trace to this. Force-settle once the proc is provably dead so
      // run() always resolves and the normal completion path runs.
      watchdog = setInterval(() => {
        const p = entry.boundProc as { _exitCode?: number | null } | undefined;
        if (p && p._exitCode != null) {
          resolver.processExited({ exitCode: p._exitCode }, this.outputTails.get(p as pty.IPty)?.text);
        }
      }, 5000);
      watchdog.unref?.();

      if (nativeCommand) {
        const startedAt = Date.now();
        nativeCommandTimer = setInterval(() => {
          const now = Date.now();
          if (nativeCommandSettles({
            compact: compactCommand,
            elapsedMs: now - startedAt,
            quietForMs: now - (this.lastOutputAt.get(jinnSessionId) ?? startedAt),
            upstreamActive: this.hasActiveUpstream(jinnSessionId),
          })) {
            resolver.completeNativeCommand();
          }
        }, 500);
        nativeCommandTimer.unref?.();
      }

      if (!nativeCommand) {
        const startedAt = Date.now();
        lostStopRecoveryTimer = setInterval(() => {
          if (resolver.isSettled) return;
          // A StopFailure is held in the grace window — the turn's fate is the
          // grace timer's call (Stop supersedes / expiry fails). Recovering
          // intermediate transcript text here would fabricate a wrong success.
          if (resolver.stopFailure) return;
          // A background re-invocation is still ahead of our prompt: the
          // transcript's newest text is its, so there is nothing of ours to
          // recover yet. The stall verdict below still applies.
          const recoverable = !resolver.awaitingBackgroundRerun;
          // Missing-Stop recovery is only safe when the model stream and local
          // tool hooks are quiet; otherwise a long-running turn can be mistaken
          // for a completed one just because transcript text exists. A pending
          // safety prompt is the exception — see recoveryBlockedByWork. Auto-
          // approve normally clears it in seconds; this catches what it cannot
          // answer, so an unanswerable dialog fails the turn instead of hanging.
          if (recoveryBlockedByWork(
            entry.activeTools,
            entry.blockedOnPermissionAt !== undefined,
            this.hasActiveUpstream(jinnSessionId),
          )) return;
          const now = Date.now();
          const elapsed = now - startedAt;
          const quietFor = now - (this.lastOutputAt.get(jinnSessionId) ?? startedAt);
          if (elapsed < LOST_STOP_RECOVERY_MIN_MS || quietFor < LOST_STOP_RECOVERY_QUIET_MS) return;
          // Under the warm-PTY gate, transcript text only counts from our own
          // UserPromptSubmit on: before it, the assistant text in the transcript
          // is a turn typed in the terminal. No live UPS = nothing of ours to
          // recover, so fall through to the stall verdict.
          const recoverFrom = recoveryFloorMs(gateOnPromptSubmit, startedAt, resolver.promptSubmittedAt);
          const sid = resolver.sessionId ?? opts.resumeSessionId;
          // Only attempt recovery when we can identify THIS turn's transcript.
          // Transcripts share one project dir keyed by Claude session id, so
          // guessing by mtime could attach another session's answer.
          const transcript = sid ? findSessionTranscript(sid, opts.claudeProfile) : undefined;
          let transcriptIsFresh = false;
          if (transcript) {
            try { transcriptIsFresh = fs.statSync(transcript).mtimeMs >= startedAt - 1000; } catch { /* unreadable */ }
          }
          if (transcript && transcriptIsFresh && recoverFrom !== undefined && recoverable) {
            const recovered = lastAssistantTextFromTranscript(transcript, Math.max(recoverFrom, resolver.backgroundRerunEndedAt ?? 0));
            if (recovered?.trim()) {
              logger.warn(`InteractiveClaudeEngine: recovered completed turn for ${jinnSessionId} after missing Stop hook`);
              resolver.completeRecovered(recovered, sid);
              return;
            }
          }
          // Nothing recoverable. Settle rather than hang: an unsettled turn pins
          // the session at "running" forever and blocks its message queue. Not
          // prefixed "Interrupted:" on purpose — that triggers quiet-preempt
          // handling downstream, and a stall must surface as a real error.
          if (shouldSettleStalledTurn(elapsed, quietFor)) {
            logger.warn(
              `InteractiveClaudeEngine: turn for ${jinnSessionId} stalled — no Stop hook and no recoverable ` +
              `transcript (claudeSessionId=${sid ?? "unknown"}) after ${Math.round(elapsed / 60_000)}m, ` +
              `${Math.round(quietFor / 60_000)}m quiet. Settling so the session unsticks.`,
            );
            resolver.interrupt("Turn stalled: the engine produced no completion signal and no recoverable transcript");
          }
        }, 2000);
        lostStopRecoveryTimer.unref?.();
      }

      result = await resolver.promise;
    } finally {
      if (watchdog) clearInterval(watchdog);
      if (nativeCommandTimer) clearInterval(nativeCommandTimer);
      if (lostStopRecoveryTimer) clearInterval(lostStopRecoveryTimer);
      // MUST run before the PTY can be handed to another turn — see pasteAndSubmit.
      entry.cancelSubmitConfirm?.();
      this.hookRegistry.unregister(jinnSessionId);
      this.active.delete(jinnSessionId);
      // A prompt typed in the terminal during this turn runs next: the next
      // gateway turn must wait for it rather than paste behind it.
      if (entry.terminalPromptQueued) this.terminalTurns.set(jinnSessionId, Date.now());
      // Interrupted with a background re-invocation still running ahead of it:
      // the next turn must not take that re-run's Stop either.
      if (resolver.awaitingBackgroundRerun && this.lifecycle.getWarm(jinnSessionId)) this.backgroundReruns.add(jinnSessionId);
      if (turnMarkedStarted) this.lifecycle.turnEnded(jinnSessionId); // manager decides kill vs keep-warm
      else cleanupSessionSettings(CLAUDE_SETTINGS_DIR, jinnSessionId);
      // Turn settled — if the CLI still has upstream requests in flight
      // (background subagents/tasks), report them now; emission was suppressed
      // while this run owned the session.
      this.maybeEmitBackground(jinnSessionId);
    }

    // Reconstruct cost from the transcript (the Stop hook carries no cost).
    const transcriptPath = resolver.transcriptPath;
    const turnTranscriptFrom = turnTranscriptStart(promptWrittenAt, resolver);
    if (transcriptPath && !result.error) {
      // After the teardown, not before it: the turn has already settled, so a
      // hook arriving while it waited would be taken as its own and lost — and
      // Claude Code starts a background re-run right after a Stop. A turn typed
      // into the terminal meanwhile may add to this cost; the wait ends as soon
      // as the answer is on disk, usually within a poll or two.
      if (!nativeCommand && result.result?.trim()) {
        await awaitTurnAnswerInTranscript(transcriptPath, turnTranscriptFrom, result.result);
      }
      // Scope to THIS turn: the transcript is cumulative and the caller adds
      // result.cost to the session total, so an unscoped sum over-counts.
      const cost = computeInteractiveCost(transcriptPath, opts.model, turnTranscriptFrom);
      if (cost) { result.cost = cost.cost; result.numTurns = cost.turns; }
      // Context-meter: most recent turn's input context (input + cache), mirroring
      // headless claude.ts so interactive/CLI-view turns also populate the meter.
      const ctx = lastTurnContextTokens(transcriptPath, turnTranscriptFrom);
      if (ctx) result.contextTokens = ctx;
    }
    // A `/compact` that Claude Code confirmed. The context meter takes the size
    // after it; the pre-compaction reading streamed during the summary is stale.
    if (compactedBy && !result.error) {
      const sid = resolver.sessionId ?? opts.resumeSessionId ?? result.sessionId;
      const hookPath = typeof compactedBy.transcript_path === "string" ? compactedBy.transcript_path : undefined;
      const statsPath = hookPath ?? (sid ? findSessionTranscript(sid, opts.claudeProfile) : undefined);
      result.compaction = statsPath ? await awaitCompactionStats(statsPath, turnTranscriptFrom) : {};
      if (result.compaction.postTokens) result.contextTokens = result.compaction.postTokens;
      else delete result.contextTokens;
    }
    // Recover lost result text: if the turn settled with no text and no API-level
    // failure, the Stop hook (which carries last_assistant_message) was dropped —
    // a gateway restart deleted gateway.json mid-turn so hook-relay.mjs couldn't
    // POST it, or the PTY died / SSE proxy dropped before it landed. The real final
    // message is still on disk in the transcript; backfill it so the parent-session
    // callback shows real output instead of "(no output)". stopFailure turns are a
    // genuine no-output API error — leave those alone.
    if (!nativeCommand && !result.error && !result.result?.trim() && !resolver.stopFailure) {
      const sid = resolver.sessionId ?? opts.resumeSessionId ?? result.sessionId;
      const recoveryPath = sid ? findSessionTranscript(sid, opts.claudeProfile) : undefined;
      // Same floor as lost-Stop recovery: under the warm-PTY gate, transcript
      // text before our own UserPromptSubmit is a turn typed in the terminal,
      // and text before a background re-invocation's Stop is that re-run's.
      const floor = recoveryFloorMs(gateOnPromptSubmit, turnTranscriptFrom, resolver.promptSubmittedAt);
      const recovered = recoveryPath && floor !== undefined
        ? lastAssistantTextFromTranscript(recoveryPath, Math.max(floor, resolver.backgroundRerunEndedAt ?? 0))
        : undefined;
      if (recovered) {
        logger.info(`Recovered ${recovered.length} chars of lost turn text for session ${jinnSessionId} from transcript (Stop hook missing)`);
        result.result = sanitizeAssistantText(recovered);
      }
    }
    // Map a StopFailure rate-limit into result.rateLimit so manager.ts's
    // wait/retry/fallback machinery engages exactly as it does for `claude -p`.
    const rl = await rateLimitFromStopFailure(resolver.stopFailure);
    if (rl) result.rateLimit = rl;
    // Turn settled as an API-error failure — the CLI may still be retrying.
    // Keep listening for a late Stop so a wrong "failed" verdict self-corrects.
    if (result.error && resolver.stopFailure) {
      this.armLateRecovery(jinnSessionId, opts);
    }
    return result;
  }

  /** Build the env passed to the claude PTY: inherits process.env but strips
   *  CLAUDECODE / CLAUDE_CODE_* so the child doesn't think it's nested, then
   *  enables fullscreen rendering. Shared by spawn() and ensureIdleSpawn().
   *  When `proxyPort` is given, points ANTHROPIC_BASE_URL at the per-PTY SSE
   *  forward proxy on 127.0.0.1 — subscription OAuth token is passed separately
   *  by claude, so this stays cc_entrypoint=cli / subsidy-safe (verified Item A). */
  private buildPtyEnv(proxyPort?: number, sessionId?: string, claudeProfile?: ClaudeProfile): Record<string, string> {
    const env = buildEngineChildEnv(process.env, {
      claudeProfile,
      scrubClaudeCode: true,
      // Belt-and-suspenders: a stray API key/token would flip the child to metered
      // API billing instead of the Max subscription. Strip both so the PTY session
      // always resolves to subscription auth (cc_entrypoint=cli).
      // ANTHROPIC_BASE_URL is set below from our own proxy port. An inherited one
      // (gateway launched from inside another jinn claude PTY) would point the
      // child at a dead loopback proxy and, worse, fail claude's first-party host
      // check without the assertion below — silently halving its context window.
      denyExact: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"],
    });
    // Use claude's main-screen renderer (NOT the alt-screen fullscreen one).
    // xterm.js's `scrollback` ring only applies to the main buffer — the alt
    // screen has no scrollback at all, so wheel-scroll in our CLI view is
    // impossible while NO_FLICKER is on. Trading mild flicker for usable scroll.
    env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN = "1";
    env.CLAUDE_CODE_RESUME_TOKEN_THRESHOLD = "999999999"; // suppress "resume from summary?" picker — always full-resume
    // Auto-compact at the model's real ceiling instead of claude's default budget.
    // The auto-compact trigger is a SEPARATE budget from the model's context window:
    // it resolves from env > settings > server client-data > per-model default, and
    // that default sits near 200K even on models whose window is 1M (opus-5 declares
    // `native_1m`). Left alone, long sessions compact ~5x more often than the model
    // requires. claude clamps this to the model's own max (`min(modelWindow, value)`)
    // and only accepts 100_000..1_000_000, so asking for 1M is safe for every model:
    // a haiku-4-5 turn silently clamps back to its real 200K window. scrubClaudeCode
    // strips any inherited value, so read the operator's override off process.env.
    env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || "1000000";
    if (sessionId) env.JINN_SESSION_ID = sessionId;
    if (proxyPort) {
      env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${proxyPort}`;
      // The proxy forwards every request UNCHANGED to api.anthropic.com, so this
      // still IS a first-party session. But claude decides "first party" by
      // string-matching the base-URL host: `Yd()` -> `T1e()` accepts only
      // `api.anthropic.com`. A 127.0.0.1 host fails that test, which makes the
      // 1M-context gate `OH()` return false and drops the model's context ceiling
      // to claude's 200K fallback -- even on models declaring `native_1m`. Since
      // `aY()` clamps with `min(modelWindow, requested)`, that also silently
      // neuters CLAUDE_CODE_AUTO_COMPACT_WINDOW above, so long sessions compact
      // ~5x more often than the model requires. This flag re-asserts what is
      // already true and restores the real 1M ceiling.
      env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL = "1";
    }
    return env;
  }

  /** Translate parsed SSE events from a PTY's proxy into StreamDeltas and route
   *  them to the active turn's onStream. A PTY outlives its turn, so we look up
   *  the live active entry here rather than capturing onStream at spawn.
   *  Any SSE event is also proof of life for a pending StopFailure grace window. */
  private handleSseEvent(jinnSessionId: string, e: SseDataEvent): void {
    const entry = this.active.get(jinnSessionId);
    if (!entry) return; // idle PTY / no turn in flight — nothing to stream
    entry.resolver.noteActivity();
    if (!entry.onStream) return;
    // A background re-invocation running ahead of this turn's prompt is not
    // this turn's reply.
    if (entry.resolver.awaitingBackgroundRerun || entry.holdingPaste) return;
    // Only the main agent's events reach here (the proxy suppresses sub-agent and
    // auxiliary streams) — but compaction shares those credentials, so deltas pass
    // through the gate before reaching the transcript.
    const gate = entry.gate ?? (entry.gate = new CompactionStreamGate());
    if (e.type === "message_start") gate.reset();
    for (const d of gate.accept(sseEventToDeltas(e))) this.forwardDelta(entry, d);
    if (e.type === "message_stop") for (const d of gate.end()) this.forwardDelta(entry, d);
  }

  /** Stream one delta to the turn, dropping a `tool_use` already reported. */
  private forwardDelta(entry: ActiveTurn, d: StreamDelta): void {
    if (d.type === "tool_use" && d.toolId) {
      const reported = entry.reportedToolIds ?? (entry.reportedToolIds = new Set());
      if (reported.has(d.toolId)) return;
      reported.add(d.toolId);
    }
    entry.onStream?.(d);
  }

  /** Allocate + start a per-PTY SSE forward proxy. Returns the proxy and its port,
   *  or {port:0} if it failed to bind — in which case the PTY is spawned WITHOUT
   *  ANTHROPIC_BASE_URL (direct to Anthropic): the turn still works, only live
   *  word-by-word streaming degrades. */
  private async startProxy(jinnSessionId: string): Promise<{ proxy: SsePtyProxy; port: number }> {
    const proxy = new SsePtyProxy(jinnSessionId, (e) => this.handleSseEvent(jinnSessionId, e), {
      // ALL requests (main + subagent + background tasks) count here — this is
      // how the gateway knows the CLI is still working after the turn settled.
      onUpstreamActivity: (info) => this.handleUpstreamActivity(jinnSessionId, info),
      // A background task's only end-of-life signal: the notification the CLI
      // sends the model. Without it a finished task would count as live until
      // the PTY dies, and a restart would nudge the session over it.
      onTaskNotifications: (taskIds) => this.dropBackgroundMonitors(jinnSessionId, taskIds),
    });
    try {
      const port = await proxy.start();
      return { proxy, port };
    } catch (err) {
      logger.warn(`SSE proxy failed to start for session ${jinnSessionId} (streaming degraded): ${err instanceof Error ? err.message : String(err)}`);
      proxy.stop();
      return { proxy, port: 0 };
    }
  }

  /** Wrap a freshly-spawned pty.IPty in a PtyHandle and wire its output into
   *  the session's scrollback ring buffer + live subscribers. On PTY exit, if this
   *  proc is the one bound to the active turn, the resolver settles it: as failed
   *  with the process's last output when it never started its session, else as
   *  interrupted (a crash with no Stop hook). A stale proc replaced by a respawn
   *  is treated as benign.
   *  `proxy` (the per-PTY SSE forward proxy) is torn down when this PTY exits. */
  private wireProcToStream(jinnSessionId: string, proc: pty.IPty, proxy?: SsePtyProxy): PtyHandle {
    const handle = createPtyHandle(proc);
    const tail = this.streams.attachWithOutputTail(
      jinnSessionId,
      proc,
      () => {
        const e = this.active.get(jinnSessionId);
        return !!(e && e.boundProc === proc && e.resolver.started);
      },
      () => { this.lastOutputAt.set(jinnSessionId, Date.now()); },
    );
    this.outputTails.set(proc, tail);
    proc.onExit((event) => {
      // Session-level cleanup MUST be identity-gated. In a kill->respawn race the
      // lifecycle/stream entries already point at the NEW PTY by the time THIS
      // (old, killed) PTY's exit fires. releaseSession is keyed by sessionId, so an
      // unguarded call here would kill the freshly-adopted PTY — whose own onExit
      // then fires the spurious second "claude process exited". Only this PTY being
      // the session's CURRENT warm handle means the cleanup is ours to do.
      const isCurrent = this.lifecycle.getWarm(jinnSessionId) === handle;
      if (isCurrent) {
        this.streams.onPtyExit(jinnSessionId, event ?? { exitCode: 0, signal: 0 });
        // Release the lifecycle entry so the dead handle isn't picked up by a future
        // run() as "warm" — that would inject into a corpse.
        this.lifecycle.releaseSession(jinnSessionId);
      }
      // Tear down THIS PTY's SSE forward proxy (one proxy per PTY) regardless.
      proxy?.stop();
      // PTY exited without a Stop hook (crash / early exit) — settle the active turn
      // as interrupted so run()'s promise doesn't hang. BUT only if this dying proc is
      // the one bound to the active turn: after a kill->respawn race the active entry
      // holds the NEW turn's resolver+proc, and this (old, released) proc must not
      // poison it. Identity mismatch => benign cleanup, no interrupt.
      const e = this.active.get(jinnSessionId);
      if (e && e.boundProc === proc) {
        e.resolver.processExited(event, tail.text);
      }
    });
    return handle;
  }

  /** Variables the remote login environment must NOT carry into `claude`.
   *  Mirrors `buildPtyEnv`'s `denyExact` plus the CLAUDECODE markers that
   *  `scrubClaudeCode` strips locally — an inherited API key would silently
   *  move the session off Max-subscription billing onto metered API billing,
   *  which is the one thing the PTY architecture exists to prevent. */
  private static readonly REMOTE_ENV_DENY = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
  ];

  /** The deny list for one spawn. When no profile is configured,
   *  `CLAUDE_CONFIG_DIR` joins it: an inherited value would otherwise pick a
   *  profile — and so a set of credentials and a trust state — that nothing in
   *  the config asked for, silently. Which profile a session runs as is always
   *  either explicit or the remote user's default, never accidental. */
  private static remoteEnvDeny(claudeConfigDir: string | undefined): string[] {
    return claudeConfigDir
      ? InteractiveClaudeEngine.REMOTE_ENV_DENY
      : [...InteractiveClaudeEngine.REMOTE_ENV_DENY, "CLAUDE_CONFIG_DIR"];
  }

  /** Environment for the REMOTE claude process.
   *
   *  `env` handed to `pty.spawn` reaches only the local ssh client — it never
   *  crosses to the other host — so everything the engine needs there is
   *  inlined into the remote command instead. This is the same set
   *  {@link buildPtyEnv} builds, minus the SSE proxy pair (no proxy runs for a
   *  remote session) and minus the inherited process env (the remote user's
   *  login environment plays that role). */
  private buildRemoteEnv(
    jinnSessionId: string,
    staging: RemoteClaudeStaging,
    claudeConfigDir: string | undefined,
  ): Record<string, string> {
    return {
      // Which Claude Code profile the session runs as. Set here rather than by
      // calling a profile-manager wrapper: those unset every CLAUDE_* variable
      // before exec, which would strip the three below — and losing
      // RESUME_TOKEN_THRESHOLD lets the "resume from summary?" picker appear in
      // front of a PTY with nobody at the keyboard. The folder-trust seed is run
      // with this same value; the two disagreeing is a guaranteed first-turn hang.
      ...(claudeConfigDir ? { CLAUDE_CONFIG_DIR: claudeConfigDir } : {}),
      // Points hook-relay.mjs and the built-in MCP server at THIS SESSION's
      // staged home — its own symlink farm and its own gateway.json — rather
      // than at a `~/.jinn` that may not exist there, or at a home shared with
      // another session whose tunnel port is not this one's.
      JINN_HOME: staging.sessionHome,
      JINN_SESSION_ID: jinnSessionId,
      CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1",
      CLAUDE_CODE_RESUME_TOKEN_THRESHOLD: "999999999",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || "1000000",
    };
  }

  /**
   * Everything that has to be true, and true again, before a remote session is
   * spawned: the host is up, its jinn-cli matches, and the gateway's JINN_HOME
   * is genuinely mounted there.
   *
   * `allowWake` is false on both spawn paths. The turn runner has already woken
   * the host and waited for it by the time it gets here, and the dashboard's
   * idle PTY must never boot someone's desktop just because a tab was opened.
   * What this call is really for is the mount sentinel, which is deliberately
   * re-checked at every spawn rather than cached — it is the one fact that can
   * go stale while the gateway keeps running.
   */
  private async prepareRemote(
    jinnSessionId: string,
    target: RemoteTarget,
    resolvedMcp: ResolvedMcpConfig | undefined,
    beforeStage?: () => boolean,
  ): Promise<{ facts: RemoteFacts; staging: RemoteClaudeStaging; remote: RemoteExecutionConfig } | undefined> {
    const remote = this.readRemoteConfig();
    assertRemoteTarget(target, remote);
    // Without a real gateway port the reverse forward would be built as
    // `-R <n>:127.0.0.1:0`, and the session would run with hooks and MCP calls
    // going nowhere — the silent-hang failure this design works hardest to
    // avoid. Refuse instead of spawning something that cannot report back.
    if (!this.readGatewayPort()) {
      throw new Error("remote spawn needs the gateway's port for the reverse tunnel, and none was provided");
    }
    const readiness = await ensureRemoteReady(target, remote, { engine: "claude", allowWake: false });
    if (!readiness.ready) throw new Error(`remote host not ready: ${readiness.reason}`);
    // Last chance to stand down without having written anything. Staging
    // rewrites this session's gateway.json with a freshly probed tunnel port,
    // and the hook relay reads that file on every hook — so a caller that
    // stages and THEN discovers a turn owns the session has already repointed
    // that turn's relay at a port it will never open a tunnel on. The relay
    // swallows a failed POST by design, so that turn would run to completion
    // with no Stop, no PreToolUse policy, and nothing reported anywhere.
    if (beforeStage?.()) return undefined;
    const staging = await prepareRemoteSession({
      target,
      remote: remote!,
      facts: readiness.facts,
      engine: "claude",
      jinnSessionId,
      gatewayPort: this.readGatewayPort(),
      ...(resolvedMcp ? { resolvedMcp } : {}),
    });
    return { facts: readiness.facts, staging, remote: remote! };
  }

  /** The remote counterpart of {@link spawn}. Same PTY contract — the object
   *  node-pty owns here is the LOCAL ssh client, whose stream carries the
   *  remote TUI, so scrollback, resize, kill and the safety-prompt parser all
   *  work against it unchanged. */
  private async spawnRemote(jinnSessionId: string, opts: EngineRunOpts): Promise<PtyHandle>;
  private async spawnRemote(jinnSessionId: string, opts: EngineRunOpts, standDown: () => boolean): Promise<PtyHandle | undefined>;
  private async spawnRemote(jinnSessionId: string, opts: EngineRunOpts, standDown?: () => boolean): Promise<PtyHandle | undefined> {
    // A turn's own spawn passes no `standDown`: it owns the session by the time
    // it reaches here and never stands down, so staging always happens. A
    // redelivery respawn (JIN-3) can outlive its turn — stopped during the
    // seconds staging takes — and must then write nothing: staging repoints
    // this session's gateway.json at a tunnel only this spawn would open.
    // Staging repoints this session's hook relay at a fresh tunnel port, so a
    // turn that cannot start is refused before it stages anything. The message
    // and system prompt only grow once quoted into the command line, so if
    // together they are already too long it surely is; the exact check below
    // covers the rest, once the staged paths are known.
    assertArgumentsFit("Claude Code", [spawnPrompt(opts) + (opts.systemPrompt ?? "")], () => REMOTE_COMMAND_LINE);
    const prepared = await this.prepareRemote(jinnSessionId, opts, opts.resolvedMcp, standDown);
    if (!prepared) return undefined;
    // Staged, but a stopped turn still must not attach to the session's stream
    // or record its model as the live PTY's.
    if (standDown?.()) return undefined;
    const { facts, staging, remote } = prepared;
    const claudeConfigDir = resolveRemoteClaudeConfigDir(opts, remote);

    const args = buildInteractiveArgs({
      prompt: spawnPrompt(opts),
      // The attachments as the remote session's staged home names them: the
      // gateway's own paths open nothing on another host.
      ...(opts.attachments?.length ? { attachments: withRemoteAttachments(opts, staging.sessionHome, jinnSessionId).attachments } : {}),
      // The REMOTE staged paths, not the gateway's.
      settingsPath: staging.settingsPath,
      ...(staging.mcpConfigPath ? { mcpConfigPath: staging.mcpConfigPath } : {}),
      resumeSessionId: opts.resumeSessionId,
      model: opts.model,
      effortLevel: opts.effortLevel,
      cliFlags: opts.cliFlags,
      appendSystemPrompt: opts.systemPrompt
        ? `${opts.systemPrompt}\n\n${MAIN_AGENT_SENTINEL}`
        : MAIN_AGENT_SENTINEL,
    });

    const sshArgs = buildSshSpawnArgs({
      destination: staging.destination,
      tunnelPort: staging.tunnelPort,
      gatewayPort: this.readGatewayPort(),
      remoteCwd: opts.remoteCwd!,
      remoteEnv: this.buildRemoteEnv(jinnSessionId, staging, claudeConfigDir),
      envFile: staging.envFilePath,
      unsetRemoteEnv: InteractiveClaudeEngine.remoteEnvDeny(claudeConfigDir),
      // Claude Code runs every hook as bare `node`; without the resolved node
      // directory on PATH the relay cannot start, no Stop ever arrives, and the
      // turn hangs forever with nothing reported anywhere.
      // The node directory first (hooks run as bare `node`), then the
      // instance's own bin/ so `mem` and its neighbours resolve by name.
      pathPrepend: [remoteNodeDir(facts), remoteSessionBinDir(staging.sessionHome)],
      bin: requireRemoteEngineBin(staging.destination, facts, "claude"),
      args,
    });
    // The whole remote command line is one argument, to ssh here and to the
    // remote shell there, so the message and the system prompt share one limit.
    assertArgumentsFit("Claude Code", sshArgs, (index) => index === sshArgs.length - 1 ? REMOTE_COMMAND_LINE : `ssh argument ${index + 1}`);

    const geom = this.lastGeom.get(jinnSessionId);
    logger.info(
      `InteractiveClaudeEngine spawning REMOTE session on ${staging.destination}:${opts.remoteCwd} `
      + `(resume: ${opts.resumeSessionId || "none"}, tunnel: ${staging.tunnelPort}→${this.readGatewayPort()}, `
      + `mcp: ${staging.mcpConfigPath ? "on" : "off"}, sseProxy: off)`,
    );
    const proc = pty.spawn(resolveBin("ssh"), sshArgs, {
      name: "xterm-256color",
      cols: geom?.cols ?? 120,
      rows: geom?.rows ?? 40,
      // The LOCAL cwd of the ssh client — irrelevant to the session, whose
      // working directory is set by the `cd` inside the remote command.
      cwd: JINN_HOME,
      env: this.buildPtyEnv(undefined, jinnSessionId),
    });
    this.spawnParams.set(jinnSessionId, { model: opts.model, effortLevel: opts.effortLevel, appendApplied: true });
    // No proxy argument: a remote session runs without the SSE forward proxy, so
    // there is nothing to tear down when the PTY exits.
    return this.wireProcToStream(jinnSessionId, proc);
  }

  /** node-pty spawn of the genuine claude binary (no -p → cc_entrypoint=cli).
   *  Allocates a per-PTY SSE forward proxy first and points the child at it. */
  private async spawn(jinnSessionId: string, opts: EngineRunOpts, settingsPath: string): Promise<PtyHandle>;
  /** With `standDown`: resolves undefined, having spawned nothing, if it turns
   *  true before the process starts (see redeliverByRespawn). */
  private async spawn(jinnSessionId: string, opts: EngineRunOpts, settingsPath: string, standDown: () => boolean): Promise<PtyHandle | undefined>;
  private async spawn(jinnSessionId: string, opts: EngineRunOpts, settingsPath: string, standDown?: () => boolean): Promise<PtyHandle | undefined> {
    // A remote employee never spawns claude on the gateway — not even as a
    // fallback. Every path that could quietly relocate the session back here is
    // closed on purpose; this is the last of them.
    if (isRemoteTarget(opts)) return standDown ? await this.spawnRemote(jinnSessionId, opts, standDown) : await this.spawnRemote(jinnSessionId, opts);
    const args = buildInteractiveArgs({
      prompt: spawnPrompt(opts),
      settingsPath,
      resumeSessionId: opts.resumeSessionId,
      model: opts.model,
      effortLevel: opts.effortLevel,
      mcpConfigPath: opts.mcpConfigPath,
      cliFlags: opts.cliFlags,
      attachments: opts.attachments,
      // Persona/org context + main-agent sentinel via the CLI flag (the settings-file
      // appendSystemPrompt KEY is ignored by claude ≥2.1.x). The sentinel lets the SSE
      // proxy tee this turn's stream to the chat pane; sub-agents have no sentinel.
      appendSystemPrompt: opts.systemPrompt
        ? `${opts.systemPrompt}\n\n${MAIN_AGENT_SENTINEL}`
        : MAIN_AGENT_SENTINEL,
    });
    // Before anything is allocated: an argument the exec will refuse fails the
    // turn here, with its size, instead of as a process that died at birth.
    if (argumentLimitApplies(false)) assertArgumentsFit("Claude Code", args, (index) => describeInteractiveArgument(args, index));
    const { proxy, port } = await this.startProxy(jinnSessionId);
    if (standDown?.()) {
      proxy.stop();
      return undefined;
    }
    const env = this.buildPtyEnv(port || undefined, jinnSessionId, opts.claudeProfile);
    ensureClaudeProfileTrust(opts.claudeProfile, opts.cwd || JINN_HOME);
    const bin = resolveBin("claude", opts.bin);
    const geom = this.lastGeom.get(jinnSessionId);
    logger.info(`InteractiveClaudeEngine spawning ${bin} (resume: ${opts.resumeSessionId || "none"}, geom: ${geom ? `${geom.cols}×${geom.rows}` : "default"}, sseProxy: ${port || "off"})`);
    const proc = pty.spawn(bin, args, {
      name: "xterm-256color",
      cols: geom?.cols ?? 120,
      rows: geom?.rows ?? 40,
      cwd: opts.cwd || JINN_HOME,
      env,
    });
    this.spawnParams.set(jinnSessionId, { model: opts.model, effortLevel: opts.effortLevel, appendApplied: true });
    return this.wireProcToStream(jinnSessionId, proc, port ? proxy : undefined);
  }

  /** Spawn an idle PTY for the CLI/xterm view. If an engineSessionId is provided,
   *  resumes that session; otherwise spawns a fresh `claude` so a brand-new CLI-mode
   *  session shows the TUI before the user types anything.
   *  Does NOTHING if a warm PTY already exists or a turn is starting.
   *  Fire-and-forget (void): allocating the per-PTY SSE proxy is async, so the
   *  actual spawn happens after a microtask; `idleSpawning` guards re-entrancy. */
  ensureIdleSpawn(jinnSessionId: string, opts: PtyIdleSpawnOpts): void {
    if (this.lifecycle.getWarm(jinnSessionId)) return;
    if (this.active.has(jinnSessionId)) return; // a turn is starting/running — let run() spawn
    if (this.idleSpawning.has(jinnSessionId)) return; // an idle spawn is already in flight
    this.idleSpawning.add(jinnSessionId);

    const remoteTarget = isRemoteTarget(opts) ? opts : undefined;
    // A local settings file is written even for a remote session: the cold-spawn
    // cleanup path (`cleanupSessionSettings`) is keyed on it, and leaving a
    // dangling entry there would be a second, subtler divergence. The REMOTE
    // path is what actually reaches `--settings`.
    const settingsPath = writeClaudeSessionSettings(jinnSessionId, opts.claudeProfile);
    const baseArgs = (settings: string): string[] => {
      const args: string[] = [
        "--chrome",
        "--dangerously-skip-permissions",
        "--disallowedTools", "AskUserQuestion", "ExitPlanMode",
        "--settings", settings,
      ];
      if (opts.engineSessionId) args.unshift("--resume", opts.engineSessionId);
      if (opts.model) args.push("--model", opts.model);
      return args;
    };
    const args = baseArgs(settingsPath);
    const bin = resolveBin("claude", opts.bin);
    // Caller (pty-ws) passes the client's current cols/rows. Cache them so a
    // future cold spawn through run() picks up the right geometry too.
    const cols = opts.cols ?? this.lastGeom.get(jinnSessionId)?.cols ?? 120;
    const rows = opts.rows ?? this.lastGeom.get(jinnSessionId)?.rows ?? 40;
    if (opts.cols && opts.rows) setCapped(this.lastGeom, jinnSessionId, { cols: opts.cols, rows: opts.rows });

    void (async () => {
      try {
        if (remoteTarget) {
          // Full parity: the dashboard's idle PTY goes over SSH too. Spawning
          // claude locally here — which is what happens if this branch is
          // missing — would `--resume` an engine session id the gateway's own
          // ~/.claude has never seen, AND get adopted as the warm PTY, so the
          // next real turn would paste its prompt into a local process and the
          // employee would quietly be running on the gateway after all.
          // The claim is re-checked INSIDE prepareRemote, after the host is
          // known good but before anything is written — see `beforeStage`. The
          // guards at the top of this method are synchronous and cannot cover
          // the multi-second staging window, during which a real turn may claim
          // the session; discovering that only afterwards is too late, because
          // this session's gateway.json would already name a tunnel port that
          // only this (now abandoned) spawn was ever going to open.
          const claimed = () => Boolean(this.lifecycle.getWarm(jinnSessionId)) || this.active.has(jinnSessionId);
          const prepared = await this.prepareRemote(jinnSessionId, remoteTarget, undefined, claimed);
          if (!prepared || claimed()) return;
          const { facts, staging, remote } = prepared;
          const claudeConfigDir = resolveRemoteClaudeConfigDir(remoteTarget, remote);
          const sshArgs = buildSshSpawnArgs({
            destination: staging.destination,
            tunnelPort: staging.tunnelPort,
            gatewayPort: this.readGatewayPort(),
            remoteCwd: remoteTarget.remoteCwd!,
            remoteEnv: this.buildRemoteEnv(jinnSessionId, staging, claudeConfigDir),
            envFile: staging.envFilePath,
            unsetRemoteEnv: InteractiveClaudeEngine.remoteEnvDeny(claudeConfigDir),
            pathPrepend: [remoteNodeDir(facts), remoteSessionBinDir(staging.sessionHome)],
            bin: requireRemoteEngineBin(staging.destination, facts, "claude"),
            args: baseArgs(staging.settingsPath),
          });
          logger.info(
            `InteractiveClaudeEngine ensureIdleSpawn REMOTE for session ${jinnSessionId} on `
            + `${staging.destination} (resume ${opts.engineSessionId || "none — fresh"}, geom ${cols}×${rows})`,
          );
          const proc = pty.spawn(resolveBin("ssh"), sshArgs, {
            name: "xterm-256color", cols, rows, cwd: JINN_HOME, env: this.buildPtyEnv(undefined, jinnSessionId),
          });
          const handle = this.wireProcToStream(jinnSessionId, proc);
          this.spawnParams.set(jinnSessionId, { model: opts.model, effortLevel: undefined, appendApplied: false });
          this.lifecycle.adopt(jinnSessionId, handle);
          return;
        }
        const { proxy, port } = await this.startProxy(jinnSessionId);
        // Re-check after the async gap: a real turn (run) or another idle spawn may
        // have claimed the session while we awaited the proxy bind. If so, don't
        // adopt a duplicate PTY — drop our proxy and bail.
        if (this.lifecycle.getWarm(jinnSessionId) || this.active.has(jinnSessionId)) {
          proxy.stop();
          return;
        }
        const env = this.buildPtyEnv(port || undefined, jinnSessionId, opts.claudeProfile);
        ensureClaudeProfileTrust(opts.claudeProfile, opts.cwd || JINN_HOME);
        logger.info(`InteractiveClaudeEngine ensureIdleSpawn for session ${jinnSessionId} (resume ${opts.engineSessionId || "none — fresh"}, geom ${cols}×${rows}, sseProxy: ${port || "off"})`);
        const proc = pty.spawn(bin, args, {
          name: "xterm-256color",
          cols,
          rows,
          cwd: opts.cwd || JINN_HOME,
          env,
        });
        const handle = this.wireProcToStream(jinnSessionId, proc, port ? proxy : undefined);
        // Idle spawn carries no --append-system-prompt (the view-only PTY); mark it so
        // the first real turn through run() cold-respawns with the persona + sentinel.
        this.spawnParams.set(jinnSessionId, { model: opts.model, effortLevel: undefined, appendApplied: false });
        this.lifecycle.adopt(jinnSessionId, handle);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`ensureIdleSpawn failed for session ${jinnSessionId}: ${message}`);
        this.streams.reportError(jinnSessionId, `failed to restore terminal: ${message}`);
      } finally {
        this.idleSpawning.delete(jinnSessionId);
      }
    })();
  }

  /** The turn's attachment paths as the session can open them. A remote
   *  session's warm PTY was staged by an earlier spawn, so its home is recomputed
   *  from the host's cached facts rather than asked of the host again. */
  private attachmentsForSession(jinnSessionId: string, opts: EngineRunOpts): string[] {
    const attachments = opts.attachments ?? [];
    if (!isRemoteTarget(opts) || attachments.length === 0) return attachments;
    const facts = cachedRemoteFacts(sshDestination(opts));
    if (!facts) throw new Error("cannot give attachments to the remote session: the host has not been staged this gateway boot");
    return mapAttachmentsForRemote(attachments, {
      sessionHome: remoteSessionHome(facts, jinnSessionId, "claude"),
      sessionId: jinnSessionId,
    });
  }

  /** Inject a follow-up prompt into a warm PTY via bracketed-paste + CR. */
  private injectPrompt(handle: PtyHandle, opts: EngineRunOpts, jinnSessionId: string, confirm?: SubmitConfirmation): (() => void) | undefined {
    const proc = (handle as any)._proc as pty.IPty | undefined;
    if (!proc) return undefined;
    let text = spawnPrompt(opts);
    if (opts.attachments?.length) {
      text += buildAttachmentSuffix(this.attachmentsForSession(jinnSessionId, opts));
    }
    return pasteAndSubmit(proc, neutralizeImagePathsForPaste(text), confirm);
  }

  subscribeWithSnapshot(
    sessionId: string,
    cb: (data: Buffer) => void,
    onControl?: (event: PtyControlEvent) => void,
  ): PtySnapshotSubscription {
    return this.streams.subscribeWithSnapshot(sessionId, cb, onControl);
  }

  restartPty(sessionId: string, opts: PtyIdleSpawnOpts): void {
    this.kill(sessionId, "Interrupted: terminal restart requested");
    this.idleSpawning.delete(sessionId);
    this.ensureIdleSpawn(sessionId, opts);
  }

  /** Write raw text to the warm PTY as a bracketed-paste + CR (same /@!-guard as injectPrompt). No-op if no warm PTY. */
  writeStdin(sessionId: string, text: string): void {
    const handle = this.lifecycle.getWarm(sessionId);
    if (!handle) return;
    const proc = (handle as any)._proc as pty.IPty | undefined;
    if (!proc) return;
    pasteAndSubmit(proc, text);
  }

  writeRaw(sessionId: string, data: string): void {
    const proc = (this.lifecycle.getWarm(sessionId) as any)?._proc as pty.IPty | undefined;
    if (proc) proc.write(data);
  }

  /** Resize the warm PTY + remember the geometry for the next cold spawn. */
  resizePty(sessionId: string, cols: number, rows: number): void {
    setCapped(this.lastGeom, sessionId, { cols, rows });
    this.streams.resize(sessionId, cols, rows);
    const handle = this.lifecycle.getWarm(sessionId);
    if (!handle) return;
    const proc = (handle as any)._proc as pty.IPty | undefined;
    if (!proc) return;
    try { proc.resize(cols, rows); } catch { /* PTY gone */ }
  }

  kill(sessionId: string, reason = "Interrupted"): void {
    // A gateway turn still waiting behind a turn typed in the terminal has not
    // touched the PTY: interrupting it ends the wait and nothing else. Killing
    // the PTY here would cut off the operator's own turn.
    const abortWait = this.terminalWaits.get(sessionId);
    const held = this.active.get(sessionId)?.holdingPaste === true;
    if (abortWait && (!this.active.has(sessionId) || held)) {
      // A registered turn still holding its paste has not touched
      // the PTY either: run() settles it with this reason.
      abortWait(reason);
      if (WAIT_ONLY_INTERRUPTS.has(reason)) return;
    }
    this.cancelLateRecovery(sessionId);
    const e = this.active.get(sessionId);
    e?.resolver.interrupt(reason.startsWith("Interrupted") ? reason : `Interrupted: ${reason}`);
    this.lifecycle.releaseSession(sessionId);
  }

  killAll(): void {
    for (const abort of [...this.terminalWaits.values()]) abort("Interrupted: gateway shutting down");
    for (const id of [...this.active.keys()]) this.kill(id, "Interrupted: gateway shutting down");
    this.lifecycle.killAll();
  }

  /** Recycle idle warm PTYs only (org-reload). Never interrupts an in-flight
   *  turn: sessions in `this.active` are skipped, so the turn that wrote the org
   *  file runs to completion on its current persona and the next turn picks up
   *  the new one via cold respawn. */
  killIdle(): void {
    // Nor a PTY with a turn typed in the terminal running, or a gateway turn
    // waiting on one: recycling it would cut off the operator's turn.
    this.lifecycle.releaseIdle((id) => this.active.has(id) || this.terminalWaits.has(id) || this.terminalTurns.has(id));
  }

  /** True only while a turn is in flight (distinct from "PTY is warm"). */
  isTurnRunning(sessionId: string): boolean {
    // A turn waiting behind one typed in the terminal is still a turn: "send
    // now" and /stop must be able to interrupt it.
    return this.active.has(sessionId) || this.terminalWaits.has(sessionId);
  }

  /** Observable progress for the in-flight turn, or undefined if none is running.
   *
   *  isTurnRunning() answers "does the gateway think a turn exists" — it is a
   *  bookkeeping lookup, so it stays true for a wedged turn forever. This answers
   *  the question that actually matters: is that turn *getting anywhere*. The
   *  reconciler uses it to catch hangs the heartbeat cannot (the heartbeat runs for
   *  as long as run() is pending, so a fresh heartbeat proves only that the gateway
   *  is still waiting), and serializeSession uses it to show stall in the UI.
   *
   *  PTY output alone is a weak signal — the TUI redraws its footer while idle at
   *  the prompt — so hooks and tool state are reported alongside it and callers
   *  weigh them together. */
  /** Single registration: a gateway turn started/stopped waiting behind a turn
   *  typed in the terminal. The gateway relays it as `session:terminal-wait`. */
  onTerminalWait(cb: (sessionId: string, waiting: boolean) => void): void {
    this.terminalWaitCb = cb;
  }

  turnProgress(sessionId: string): TurnProgress | undefined {
    const entry = this.active.get(sessionId);
    const waitStartedAt = this.terminalWaitStartedAt.get(sessionId);
    if (!entry && waitStartedAt !== undefined) {
      return { lastProgressAt: waitStartedAt, awaitingSubmit: false, activeTools: 0, activeUpstream: false, waitingForTerminalTurn: true };
    }
    if (!entry) return undefined;
    return {
      lastProgressAt: Math.max(entry.startedAt, entry.lastHookAt, this.lastOutputAt.get(sessionId) ?? 0),
      // Held behind a background re-invocation, the prompt has not been sent
      // yet: "not accepted by the engine" would be wrong, and resending it
      // from the CLI view would duplicate it.
      awaitingSubmit: !entry.promptSubmitted && !entry.holdingPaste,
      activeTools: entry.activeTools,
      activeUpstream: this.hasActiveUpstream(sessionId),
    };
  }

  /** True iff a warm PTY exists for this session (in the lifecycle manager). */
  hasWarmPty(sessionId: string): boolean {
    return this.lifecycle.getWarm(sessionId) !== undefined;
  }

  /** Track viewing state from the frontend. Called by pty-ws on `viewing` messages
   *  from CliTerminal (mount/unmount + Page Visibility). Ref-counted so multiple tabs
   *  viewing the same session keep it warm until the last one leaves. */
  setViewing(sessionId: string, viewing: boolean): void {
    if (viewing) this.lifecycle.viewerEnter(sessionId);
    else this.lifecycle.viewerLeave(sessionId);
  }

  /** InterruptibleEngine.isAlive — true if a turn OR a warm PTY exists. */
  isAlive(sessionId: string): boolean {
    return this.active.has(sessionId) || this.lifecycle.getWarm(sessionId) !== undefined;
  }

  /** Keep listening for a late Stop after an API-error settle. Public visibility
   *  is for tests; used by run() and kill(). No-op when the caller didn't provide
   *  onLateRecovery. */
  armLateRecovery(jinnSessionId: string, opts: EngineRunOpts): void {
    if (!opts.onLateRecovery) return;
    this.cancelLateRecovery(jinnSessionId);
    const timer = setTimeout(() => this.cancelLateRecovery(jinnSessionId), LATE_RECOVERY_WINDOW_MS);
    timer.unref?.();
    this.lateRecovery.set(jinnSessionId, { timer });
    this.hookRegistry.register(jinnSessionId, (h) => {
      // A new prompt means the failed turn is over and someone typed in the
      // terminal: its Stop is theirs, not a late recovery. Step aside
      // so it reaches the external-turn sync.
      if (h.hook_event_name === "UserPromptSubmit") {
        logger.info(`InteractiveClaudeEngine: late recovery for ${jinnSessionId} abandoned — a new prompt started in the terminal`);
        this.cancelLateRecovery(jinnSessionId);
        return;
      }
      if (h.hook_event_name !== "Stop") return;
      const text = String(h.last_assistant_message ?? "");
      const sid = typeof h.session_id === "string" ? h.session_id : "";
      this.cancelLateRecovery(jinnSessionId);
      const safeText = sanitizeAssistantText(text);
      if (safeText.trim()) {
        logger.info(`InteractiveClaudeEngine: late Stop superseded failed turn for ${jinnSessionId}`);
        opts.onLateRecovery?.({ result: safeText, sessionId: sid });
      } else {
        logger.info(`InteractiveClaudeEngine: late Stop with no text for ${jinnSessionId} — recovery abandoned`);
      }
    });
  }

  /** Tear down a pending late-recovery listener (new turn starting / kill / expiry). */
  cancelLateRecovery(jinnSessionId: string): void {
    const lr = this.lateRecovery.get(jinnSessionId);
    if (!lr) return;
    clearTimeout(lr.timer);
    this.lateRecovery.delete(jinnSessionId);
    this.hookRegistry.unregister(jinnSessionId);
  }
}
