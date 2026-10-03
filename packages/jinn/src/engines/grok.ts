import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { InterruptibleEngine, EngineRunOpts, EngineResult, StreamDelta } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { extractActivityReceiptId } from "../shared/activity-receipts.js";
import { resolveBin } from "../shared/resolve-bin.js";
import { buildEngineChildEnv } from "../shared/child-env.js";
import { tailTranscriptLines, type TranscriptTailer } from "./transcript-tailer.js";
import { argumentLimitApplies, assertArgumentsFit } from "./argv-limit.js";
import { prepareGrokProjectMcpConfig, cleanupGrokProjectMcpConfig, grokJinnSessionEnv, type GrokMcpAttachHandle } from "./grok-mcp.js";
import {
  asRecord,
  compactText,
  extractError,
  isReasoningType,
  planStatusFromGrokUpdate,
  safeJsonSnippet,
  stringField,
  stripReasoningMarkup,
  toolNameFromGrokUpdate,
} from "./grok-json.js";

export const GROK_SESSIONS_DIR = path.join(os.homedir(), ".grok", "sessions");

const STDERR_MAX = 10 * 1024;
const TRANSCRIPT_TAIL_POLL_MS = 250;
const TRANSCRIPT_DISCOVER_POLL_MS = 200;

interface LiveProcess {
  proc: ChildProcess;
  terminationReason: string | null;
}

export interface GrokParsedLine {
  deltas: StreamDelta[];
  sessionId?: string;
  doneText?: string;
  error?: string;
  terminal?: boolean;
  contextTokens?: number;
  /** A reasoning event: its payload stays dropped, but it marks the end of an answer block. */
  reasoning?: boolean;
}

export function grokCliFlags(flags: string[] | undefined): string[] {
  // `--chrome` is a Claude Code flag. Shared employee config can carry it; Grok
  // rejects unknown flags before a session starts.
  return (flags ?? []).filter((flag) => flag !== "--chrome");
}

export function buildGrokHeadlessArgs(opts: EngineRunOpts, prompt: string, sessionId: string): string[] {
  const args = ["--no-auto-update"];
  if (opts.model) args.push("--model", opts.model);
  if (opts.effortLevel && opts.effortLevel !== "default") args.push("--effort", opts.effortLevel);
  if (opts.cwd) args.push("--cwd", opts.cwd);
  if (opts.resumeSessionId) args.push("--resume", sessionId);
  args.push("--always-approve", "--output-format", "streaming-json");
  args.push(...grokCliFlags(opts.cliFlags));
  args.push("-p", prompt);
  return args;
}

interface TranscriptStat {
  mtimeMs: number;
  size: number;
}

function walkFiles(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(p, out);
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

const GROK_TRANSCRIPT_NAMES = ["updates.jsonl", "chat_history.jsonl", "events.jsonl"];

function isGrokTranscriptFile(file: string): boolean {
  return GROK_TRANSCRIPT_NAMES.includes(path.basename(file));
}

function isGrokUpdatesFile(file: string): boolean {
  return path.basename(file) === "updates.jsonl";
}

function sortGrokTranscriptFiles(files: string[]): string[] {
  const rank = (file: string) => {
    const index = GROK_TRANSCRIPT_NAMES.indexOf(path.basename(file));
    return index === -1 ? GROK_TRANSCRIPT_NAMES.length : index;
  };
  return files.filter(isGrokTranscriptFile).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

function listTranscriptStats(root = GROK_SESSIONS_DIR): Map<string, TranscriptStat> {
  const files = new Map<string, TranscriptStat>();
  for (const file of sortGrokTranscriptFiles(walkFiles(root))) {
    try {
      const stat = fs.statSync(file);
      files.set(file, { mtimeMs: stat.mtimeMs, size: stat.size });
    } catch {
      // gone
    }
  }
  return files;
}

function parseSessionIdFromFile(filePath: string): string | undefined {
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(64 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      for (const line of buf.subarray(0, n).toString("utf-8").split("\n")) {
        const parsed = parseGrokJsonLine(line);
        if (parsed?.sessionId) return parsed.sessionId;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Grok files a session under `<sessions>/<url-encoded absolute cwd>/<session-uuid>/`,
 *  so a run's own transcript is discoverable from its cwd alone — before grok has
 *  revealed any session id. */
function grokCwdSessionsRoots(cwd: string | undefined, root = GROK_SESSIONS_DIR): string[] {
  if (!cwd) return [];
  const variants = new Set<string>([path.resolve(cwd)]);
  try { variants.add(fs.realpathSync(cwd)); } catch { /* cwd may not exist yet */ }
  return [...variants].map((dir) => path.join(root, encodeURIComponent(dir)));
}

function fileUnderCwdSessions(file: string, roots: string[]): boolean {
  return roots.some((sessionRoot) => file === sessionRoot || file.startsWith(sessionRoot + path.sep));
}

function transcriptMatchesSession(filePath: string, sessionId: string): boolean {
  return filePath.includes(sessionId) || parseSessionIdFromFile(filePath) === sessionId;
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") return stripReasoningMarkup(value);
  if (!Array.isArray(value)) return "";
  return value
    .map((block) => {
      if (typeof block === "string") return stripReasoningMarkup(block);
      const b = asRecord(block);
      if (!b) return "";
      if (isReasoningType(b.type) || isReasoningType(b.kind) || isReasoningType(b.role)) return "";
      const nested = asRecord(b.content);
      if (nested) {
        if (isReasoningType(nested.type) || isReasoningType(nested.kind) || isReasoningType(nested.role)) return "";
        const nestedDirect = stringField(nested, ["text", "content", "value", "output"]);
        return nestedDirect ? stripReasoningMarkup(nestedDirect) : textFromContent(nested.content);
      }
      const direct = stringField(b, ["text", "content", "value", "output"]);
      if (direct) return stripReasoningMarkup(direct);
      return Array.isArray(b.content) ? textFromContent(b.content) : "";
    })
    .join("");
}

function textFromUnknown(value: unknown): string {
  if (typeof value === "string") return stripReasoningMarkup(value);
  if (Array.isArray(value)) return textFromContent(value);
  const obj = asRecord(value);
  if (!obj) return "";
  if (isReasoningType(obj.type) || isReasoningType(obj.kind) || isReasoningType(obj.role)) return "";
  const direct = stringField(obj, ["text", "content", "value", "output", "message"]);
  return direct ? stripReasoningMarkup(direct) : textFromContent(obj.content);
}

function toolResultTextFromGrokUpdate(update: Record<string, unknown>): string {
  const contentText = textFromUnknown(update.content);
  if (contentText) return compactText(contentText);
  const rawOutputText = textFromUnknown(update.rawOutput);
  if (rawOutputText) return compactText(rawOutputText);
  const status = stringField(update, ["status", "type", "outcome"]);
  return status ? compactText(status) : "Done";
}

function extractText(obj: Record<string, unknown>, eventType: string, terminal: boolean): { text: string; snapshot: boolean } {
  const message = asRecord(obj.message);
  const role = String(obj.role ?? message?.role ?? "").toLowerCase();
  if (role === "user" || role === "system" || eventType === "user" || eventType === "system") {
    return { text: "", snapshot: true };
  }

  const deltaText = textFromUnknown(obj.delta);
  if (deltaText) return { text: deltaText, snapshot: false };

  const messageText = message ? textFromContent(message.content) || textFromUnknown(message.text) : "";
  if (messageText) return { text: messageText, snapshot: true };

  const contentText = textFromContent(obj.content);
  if (contentText) return { text: contentText, snapshot: !eventType.includes("delta") && !eventType.includes("chunk") };

  const directText = terminal
    ? stringField(obj, ["result", "final", "answer", "output", "text", "content"])
    : stringField(obj, ["text", "content"]);
  if (!directText) return { text: "", snapshot: true };
  return { text: directText, snapshot: !eventType.includes("delta") && !eventType.includes("chunk") };
}

function extractContextTokens(obj: Record<string, unknown>): number | undefined {
  const usage = asRecord(obj.usage) ?? asRecord(obj.token_usage) ?? asRecord(obj.tokens);
  const meta = asRecord(obj._meta);
  const candidate =
    usage?.input_tokens ??
    usage?.inputTokens ??
    usage?.context_tokens ??
    usage?.contextTokens ??
    obj.context_tokens ??
    obj.contextTokens ??
    meta?.totalTokens ??
    meta?.contextTokens;
  const n = Number(candidate ?? 0);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function parseGrokJsonLine(line: string): GrokParsedLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(trimmed);
    const record = asRecord(parsed);
    if (!record) return null;
    obj = record;
  } catch {
    logger.debug(`[grok stream] unparseable line: ${trimmed.slice(0, 100)}`);
    return null;
  }

  const method = String(obj.method ?? "");
  if (method === "session/update") {
    const params = asRecord(obj.params);
    const update = asRecord(params?.update);
    const updateType = String(update?.sessionUpdate ?? "").toLowerCase();
    const nestedSessionId = params ? stringField(params, ["sessionId", "session_id"]) : undefined;
    const contextTokens = (update ? extractContextTokens(update) : undefined) ??
      (params ? extractContextTokens(params) : undefined) ??
      extractContextTokens(obj);
    const deltas: StreamDelta[] = [];
    if (contextTokens) deltas.push({ type: "context", content: String(contextTokens) });
    if (updateType === "agent_message_chunk") {
      const content = asRecord(update?.content);
      const text = textFromUnknown(content?.text ?? update?.content);
      return {
        deltas: text ? [...deltas, { type: "text", content: text }] : deltas,
        sessionId: nestedSessionId,
        terminal: false,
        contextTokens,
      };
    }
    if (isReasoningType(updateType)) {
      // Raw model reasoning ("thought") must NEVER reach the UI — the payload can
      // contain chain-of-thought, <thinking> blocks, even draft answers. Drop it
      // entirely (no placeholder line): the pre-token spinner covers the reasoning
      // stretch, while tool cards (transcript) and the live answer text (stdout)
      // provide the real mid-turn activity the user wants to see.
      return { deltas, sessionId: nestedSessionId, terminal: false, contextTokens, reasoning: true };
    }
    if (updateType === "tool_call") {
      const toolName = update ? toolNameFromGrokUpdate(update) : undefined;
      return {
        deltas: [
          ...deltas,
          {
            type: "tool_use",
            content: toolName ? `Using ${toolName}` : "Using tool",
            toolName,
            toolId: update ? stringField(update, ["toolCallId", "tool_call_id", "id"]) : undefined,
            input: update ? safeJsonSnippet(update.rawInput) : undefined,
          },
        ],
        sessionId: nestedSessionId,
        terminal: false,
        contextTokens,
      };
    }
    if (updateType === "tool_call_update") {
      const status = String(update?.status ?? update?.type ?? "").toLowerCase();
      const completed = ["completed", "complete", "done", "success", "failed", "failure", "error"].includes(status);
      if (!completed) return { deltas, sessionId: nestedSessionId, terminal: false, contextTokens };
      const toolName = update ? toolNameFromGrokUpdate(update) : undefined;
      const rawOutput = asRecord(update?.rawOutput);
      const rawContent = Array.isArray(rawOutput?.content)
        ? (rawOutput.content as unknown[])
            .find((entry) => asRecord(entry)?.type === "text")
        : undefined;
      const activityReceiptId = extractActivityReceiptId(
        asRecord(rawContent)?.text ?? update?.rawOutput,
        { isError: ["failed", "failure", "error"].includes(status) || rawOutput?.isError === true },
      );
      return {
        deltas: [
          ...deltas,
          {
            type: "tool_result",
            content: update ? toolResultTextFromGrokUpdate(update) : "Done",
            toolName,
            toolId: update ? stringField(update, ["toolCallId", "tool_call_id", "id"]) : undefined,
            ...(activityReceiptId ? { activityReceiptId } : {}),
          },
        ],
        sessionId: nestedSessionId,
        terminal: false,
        contextTokens,
      };
    }
    if (updateType === "plan") {
      const status = update ? planStatusFromGrokUpdate(update) : undefined;
      return {
        deltas: status ? [...deltas, { type: "status", content: status }] : deltas,
        sessionId: nestedSessionId,
        terminal: false,
        contextTokens,
      };
    }
    if (updateType === "retry_state") {
      const attempt = update?.attempt;
      const max = update?.max_retries;
      const attemptText = typeof attempt === "string" || typeof attempt === "number" ? String(attempt) : "";
      const maxText = typeof max === "string" || typeof max === "number" ? String(max) : "";
      const reason = update ? stringField(update, ["reason", "message", "error"]) : undefined;
      const label = `Grok retrying${attemptText ? ` (${attemptText}${maxText ? `/${maxText}` : ""})` : ""}${reason ? `: ${compactText(reason, 180)}` : ""}`;
      return {
        deltas: [...deltas, { type: "status", content: label }],
        sessionId: nestedSessionId,
        terminal: false,
        contextTokens,
      };
    }
    return { deltas, sessionId: nestedSessionId, terminal: false, contextTokens };
  }

  const rawType = String(obj.type ?? obj.event ?? obj.kind ?? "");
  const eventType = rawType.toLowerCase();
  const terminal =
    Boolean(obj.done || obj.is_final || obj.final) ||
    /complete|completed|done|result|final|agent_end|turn_end/.test(eventType) ||
    eventType === "end";
  const deltas: StreamDelta[] = [];

  const sessionId = stringField(obj, ["session_id", "sessionId", "conversation_id", "conversationId"]);
  const contextTokens = extractContextTokens(obj);
  if (contextTokens) deltas.push({ type: "context", content: String(contextTokens) });

  if (eventType.includes("error") || eventType.includes("failed") || obj.error !== undefined) {
    const error = extractError(obj) ?? "Grok reported an error";
    return { deltas: [{ type: "error", content: error }, ...deltas], sessionId, error, terminal: true };
  }

  if (isReasoningType(eventType)) {
    // Raw reasoning chunk — never displayed (same contract as agent_thought_chunk).
    // Dropped entirely; no placeholder status line.
    return { deltas, sessionId, terminal, contextTokens, reasoning: true };
  }

  if (eventType === "text") {
    const text = textFromUnknown(obj.data);
    if (text) deltas.push({ type: "text", content: text });
    return { deltas, sessionId, terminal, contextTokens };
  }

  const toolName = stringField(obj, ["toolName", "tool_name", "name"]) ?? stringField(asRecord(obj.tool) ?? {}, ["name"]);
  if (eventType.includes("tool") && (eventType.includes("start") || eventType.includes("call") || eventType.includes("use"))) {
    const content = toolName ? `Using ${toolName}` : "Using tool";
    return {
      deltas: [{ type: "tool_use", content, toolName, toolId: stringField(obj, ["toolCallId", "tool_call_id", "id"]) }, ...deltas],
      sessionId,
      terminal: false,
      contextTokens,
    };
  }
  if (eventType.includes("tool") && (eventType.includes("end") || eventType.includes("result") || eventType.includes("complete"))) {
    const content = textFromUnknown(obj.result) || stringField(obj, ["output", "content"]) || "Done";
    return {
      deltas: [{ type: "tool_result", content: content.slice(0, 500), toolName, toolId: stringField(obj, ["toolCallId", "tool_call_id", "id"]) }, ...deltas],
      sessionId,
      terminal: false,
      contextTokens,
    };
  }

  const { text, snapshot } = extractText(obj, eventType, terminal);
  let doneText: string | undefined;
  if (text) {
    const deltaType: StreamDelta["type"] = snapshot ? "text_snapshot" : "text";
    deltas.push({ type: deltaType, content: text });
    if (terminal || snapshot) doneText = text;
  }

  return { deltas, sessionId, doneText, terminal, contextTokens };
}

/**
 * Deltas the HEADLESS engine forwards to the UI for a parsed line, by raw stream.
 *
 * The headless engine consumes two streams that are NOT mutually ordered: grok's
 * stdout (answer text, real-time) and the transcript tail (tool lifecycle only,
 * lagging stdout by the poll interval).
 *
 * Answer text is streamed live from STDOUT so the user sees Grok's real message
 * type out as it is generated (Grok emits all reasoning first, then the answer text
 * as one contiguous run, then `end`). The SAME answer also appears in the transcript
 * as `agent_message_chunk`, so transcript text is dropped here to avoid emitting it
 * twice — and `resultText` is accumulated from stdout only. The canonical result is
 * reconciled against the streamed text at completion by identity (see
 * use-live-session `session:completed`), so a transcript `tool_use` that lands after
 * the streamed answer no longer renders a duplicate bubble. That identity holds per
 * ROW, not per turn: a tool card closes the current text row, so `resultText` restarts
 * there too and stays equal to the last streamed row rather than to the whole turn.
 * Tool lifecycle + context stream live from the transcript. Reasoning is already
 * dropped by `parseGrokJsonLine`.
 */
export function grokVisibleDeltas(deltas: StreamDelta[], source: "stdout" | "transcript"): StreamDelta[] {
  return deltas.filter((delta) => {
    if (delta.type === "text" || delta.type === "text_snapshot") {
      // Live answer text comes from stdout; the transcript copy is a duplicate.
      return source === "stdout";
    }
    if (source === "transcript") {
      return delta.type === "tool_use" || delta.type === "tool_result" || delta.type === "context";
    }
    return true;
  });
}

export class GrokEngine implements InterruptibleEngine {
  name = "grok" as const;
  private liveProcesses = new Map<string, LiveProcess>();

  kill(sessionId: string, reason = "Interrupted"): void {
    const live = this.liveProcesses.get(sessionId);
    if (!live) return;
    live.terminationReason = reason;
    logger.info(`Killing Grok process for session ${sessionId}`);
    this.signalProcess(live.proc, "SIGTERM");
    setTimeout(() => {
      if (live.proc.exitCode === null) this.signalProcess(live.proc, "SIGKILL");
    }, 2000);
  }

  killAll(): void {
    for (const sessionId of this.liveProcesses.keys()) this.kill(sessionId, "Interrupted: gateway shutting down");
  }

  /** Batch engine: no warm-PTY reuse, every live process is an in-flight turn.
   *  Nothing idle to recycle on org-reload — no-op. */
  killIdle(): void {
    /* no-op */
  }

  isAlive(sessionId: string): boolean {
    const live = this.liveProcesses.get(sessionId);
    return !!live && !live.proc.killed && live.proc.exitCode === null;
  }

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    const trackingId = opts.sessionId || `grok-${Date.now()}`;
    const grokSessionId = opts.resumeSessionId || trackingId;

    let prompt = opts.prompt;
    if (opts.systemPrompt && !opts.resumeSessionId) prompt = `${opts.systemPrompt}\n\n---\n\n${prompt}`;
    if (opts.attachments?.length) {
      prompt += "\n\nAttached files:\n" + opts.attachments.map((a) => `- ${a}`).join("\n");
    }

    const bin = resolveBin("grok", opts.bin);
    const args = buildGrokHeadlessArgs(opts, prompt, grokSessionId);
    // The prompt rides `-p` as one command-line argument. One the exec would
    // refuse fails the turn here, naming its size and the limit, before the
    // project's MCP config is written.
    if (argumentLimitApplies(false)) {
      assertArgumentsFit("Grok", args, (index) => index === args.length - 1 ? "the message (with its system prompt and attachment list)" : `command-line argument ${index + 1}`);
    }
    logger.info(`Grok engine starting: ${bin} --model ${opts.model || "default"} (session: ${grokSessionId})`);
    const transcriptBaseline = listTranscriptStats();

    // GRS-012c: attach the resolved MCP servers via a session-scoped
    // `<cwd>/.grok/config.toml` (grok's only per-session MCP lever). Written before
    // spawn so grok discovers it at startup; torn down on every settle path below
    // so the run leaves zero residue in the project tree.
    const grokMcp: GrokMcpAttachHandle = prepareGrokProjectMcpConfig(opts.cwd, opts.resolvedMcp);

    return new Promise((resolve, reject) => {
      let mcpCleanedUp = false;
      const cleanupMcpOnce = () => {
        if (mcpCleanedUp) return;
        mcpCleanedUp = true;
        cleanupGrokProjectMcpConfig(grokMcp);
      };

      const proc = spawn(bin, args, {
        cwd: opts.cwd,
        // GRS-018/GRS-017: the per-session caller identity rides the grok CHILD
        // env (grok forwards its full env to the MCP servers it spawns), because
        // the SHARED .grok/config.toml must stay byte-identical across concurrent
        // sessions and can never carry a per-session value (grok-mcp.ts doc).
        env: { ...this.buildCleanEnv(trackingId), ...grokJinnSessionEnv(opts.resolvedMcp) },
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });

      this.liveProcesses.set(trackingId, { proc, terminationReason: null });

      let stderr = "";
      let lineBuf = "";
      let resultText = "";
      let turnError: string | null = null;
      let lastContextTokens: number | undefined;
      let settled = false;
      let resolvedSessionId = grokSessionId;
      let resolvedSessionFromStdout = Boolean(opts.resumeSessionId);
      let transcriptTailer: TranscriptTailer | undefined;
      let transcriptDiscover: NodeJS.Timeout | undefined;
      let attachedTranscriptSessionId: string | undefined;
      let blockBreakPending = false;

      const expectedTranscriptSessionId = () =>
        opts.resumeSessionId || (resolvedSessionFromStdout ? resolvedSessionId : attachedTranscriptSessionId);

      const stopTranscriptWatch = () => {
        if (transcriptDiscover) {
          clearInterval(transcriptDiscover);
          transcriptDiscover = undefined;
        }
        transcriptTailer?.stop();
        transcriptTailer = undefined;
      };

      // Settle the turn on grok's explicit end-of-turn marker (`{"type":"end",
      // "stopReason":"EndTurn"}` on stdout — parsed as `terminal`). We must NOT wait
      // solely for `proc.on("close")`: `close` only fires once every fd onto the
      // child's stdout pipe is gone, so a grandchild a `bash`/shell tool call left
      // behind (inheriting that pipe) keeps the pipe open and the turn hangs forever
      // even though grok itself already exited (`exit` fired). That is exactly the
      // freeze seen when a turn writes to org/ + skills/ (it runs hatch bash steps);
      // knowledge-only turns used the `write` tool, spawned no lingering child, and
      // closed normally. Resolving on the terminal event decouples completion from
      // process exit. `close` below stays as the fallback for crashes/no-end exits.
      const settleOnTerminal = () => {
        if (settled) return;
        settled = true;
        stopTranscriptWatch();
        cleanupMcpOnce();
        this.liveProcesses.delete(trackingId);
        // The detached child has signalled EndTurn and will exit; don't let its
        // (or a lingering grandchild's) open stdout pipe keep the event loop busy.
        try { proc.unref?.(); } catch { /* not detached / already gone */ }
        resolve({
          sessionId: resolvedSessionId,
          result: resultText,
          error: resultText.trim() ? undefined : (turnError ?? undefined),
          numTurns: 1,
          ...(typeof lastContextTokens === "number" ? { contextTokens: lastContextTokens } : {}),
        });
      };

      // Re-open the paragraph the reasoning run closed; codex.ts:648 does the same
      // between its adjacent message blocks. Both the streamed delta and resultText
      // carry the break, so the two stay identical for the completion reconcile.
      const withBlockBoundary = (delta: StreamDelta): StreamDelta => {
        if (delta.type !== "text" || !blockBreakPending) return delta;
        blockBreakPending = false;
        if (resultText.endsWith("\n") || delta.content.startsWith("\n")) return delta;
        return { ...delta, content: `\n\n${delta.content}` };
      };

      const handleParsed = (parsed: GrokParsedLine | null) => {
        if (!parsed) return;
        if (parsed.sessionId) {
          resolvedSessionId = parsed.sessionId;
          resolvedSessionFromStdout = true;
        }
        if (parsed.contextTokens) lastContextTokens = parsed.contextTokens;
        if (parsed.error) turnError = parsed.error;
        // Grok streams the answer as bare chunks with no block marker, so a reasoning
        // run between two chunks is the only end-of-block signal stdout carries.
        if (parsed.reasoning && resultText) blockBreakPending = true;
        // Accumulate answer text into resultText (the single authoritative result)
        // AND stream it live (grokVisibleDeltas forwards stdout text). The two are
        // identical, so the FE reconciles them by identity at completion — no
        // duplicate bubble. See grokVisibleDeltas.
        const deltas = parsed.deltas.map(withBlockBoundary);
        for (const delta of deltas) {
          if (delta.type === "text") resultText += delta.content;
          if (delta.type === "text_snapshot") resultText = delta.content;
        }
        for (const delta of grokVisibleDeltas(deltas, "stdout")) opts.onStream?.(delta);
        if (parsed.doneText) resultText = parsed.doneText;
        if (parsed.terminal) settleOnTerminal();
      };

      const handleTranscriptParsed = (parsed: GrokParsedLine | null) => {
        if (!parsed) return;
        const expected = expectedTranscriptSessionId();
        if (parsed.sessionId && expected && parsed.sessionId !== expected) {
          logger.warn(`Ignoring Grok transcript event for session ${parsed.sessionId}; expected ${expected}`);
          return;
        }
        if (parsed.sessionId && !expected) attachedTranscriptSessionId = parsed.sessionId;
        if (parsed.contextTokens) lastContextTokens = parsed.contextTokens;
        // Tool lifecycle updates only appear in the transcript; mirror them (plus
        // context) live. Answer text is left to stdout/resultText — grokVisibleDeltas
        // drops it here so it is never emitted twice.
        for (const delta of grokVisibleDeltas(parsed.deltas, "transcript")) {
          // A tool card closes the current text row, so resultText restarts with it
          // (see grokVisibleDeltas): the text before the card is already its own
          // persisted row, and repeating it inside the final message renders twice.
          if (delta.type === "tool_use") {
            resultText = "";
            blockBreakPending = false;
          }
          opts.onStream?.(delta);
        }
      };

      const attachTranscriptTail = (filePath: string, offset: number) => {
        if (transcriptTailer) return;
        transcriptTailer = tailTranscriptLines(
          filePath,
          offset,
          (line) => handleTranscriptParsed(parseGrokJsonLine(line)),
          { pollMs: TRANSCRIPT_TAIL_POLL_MS, label: "Grok headless transcript" },
        );
      };

      // A fresh turn learns its session id only from grok's `end` line, which settles
      // the turn in the same tick — so waiting for one meant the tail never attached
      // and no tool card ever reached the UI. The cwd is enough to find our own
      // transcript before then, because grok keys the directory by it.
      const cwdSessionsRoots = grokCwdSessionsRoots(opts.cwd);
      transcriptDiscover = setInterval(() => {
        if (transcriptTailer) return;
        const expected = expectedTranscriptSessionId();
        const current = listTranscriptStats();
        const candidates = sortGrokTranscriptFiles(
          [...current.entries()]
            .filter(([file, stat]) => {
              const prev = transcriptBaseline.get(file);
              if (prev && stat.mtimeMs <= prev.mtimeMs && stat.size <= prev.size) return false;
              if (expected) return transcriptMatchesSession(file, expected);
              // `updates.jsonl` only: it is the one file carrying the tool lifecycle,
              // and grok writes it seconds AFTER chat_history.jsonl/events.jsonl appear
              // in the same directory — attaching to whichever landed first bought a
              // tail with no tool events in it at all. Match both resolve() and
              // realpath() encodings: grok keys the dir by the real cwd (`/tmp` is
              // `/private/tmp` on macOS).
              return !prev && isGrokUpdatesFile(file) && fileUnderCwdSessions(file, cwdSessionsRoots);
            })
            .map(([file]) => file),
        );
        const first = candidates[0];
        if (!first) return;
        // Without a session id, "appeared under our cwd after the spawn" is all that
        // identifies the transcript — and two concurrent turns in one cwd both match.
        // Refuse the ambiguous attach and wait for a unique candidate, as
        // grok-interactive.ts:305-313 already does for the same race.
        if (!expected && new Set(candidates.map((file) => path.dirname(file))).size > 1) {
          logger.warn(`Ambiguous fresh Grok transcripts under ${cwdSessionsRoots.join(" | ")}; waiting for a unique candidate`);
          return;
        }
        const prev = transcriptBaseline.get(first);
        attachedTranscriptSessionId ??= parseSessionIdFromFile(first);
        attachTranscriptTail(first, prev?.size ?? 0);
        if (transcriptDiscover) {
          clearInterval(transcriptDiscover);
          transcriptDiscover = undefined;
        }
      }, TRANSCRIPT_DISCOVER_POLL_MS);
      transcriptDiscover.unref?.();

      proc.stdout.on("data", (d: Buffer) => {
        lineBuf += d.toString();
        const lines = lineBuf.split("\n");
        lineBuf = lines.pop() || "";
        for (const line of lines) handleParsed(parseGrokJsonLine(line));
      });

      proc.stderr.on("data", (d: Buffer) => {
        const chunk = d.toString();
        stderr = (stderr + chunk).slice(-STDERR_MAX);
        for (const line of chunk.trim().split("\n").filter(Boolean)) logger.debug(`[grok stderr] ${line}`);
      });

      proc.stdin.end();

      // Final resolution for a turn that did NOT settle on the `end` marker
      // (crash, kill, or an `end` line that never arrived/parsed). Shared by
      // `close` and the `exit`-grace backstop below so the turn always settles
      // exactly once with whatever `resultText` accumulated.
      const finalizeNonTerminal = (code: number | null) => {
        if (settled) return;
        settled = true;
        stopTranscriptWatch();
        cleanupMcpOnce();
        handleParsed(parseGrokJsonLine(lineBuf));
        const terminationReason = this.liveProcesses.get(trackingId)?.terminationReason ?? null;
        this.liveProcesses.delete(trackingId);

        if (terminationReason) {
          resolve({
            sessionId: resolvedSessionId,
            result: resultText,
            error: terminationReason,
            ...(typeof lastContextTokens === "number" ? { contextTokens: lastContextTokens } : {}),
          });
          return;
        }

        if (code === 0 || resultText.trim()) {
          resolve({
            sessionId: resolvedSessionId,
            result: resultText,
            error: resultText.trim() ? undefined : (turnError ?? undefined),
            numTurns: 1,
            ...(typeof lastContextTokens === "number" ? { contextTokens: lastContextTokens } : {}),
          });
          return;
        }

        const errMsg = turnError || `Grok exited with code ${code}: ${stderr.slice(0, 500)}`;
        logger.error(errMsg);
        resolve({
          sessionId: resolvedSessionId,
          result: resultText,
          error: errMsg,
          ...(typeof lastContextTokens === "number" ? { contextTokens: lastContextTokens } : {}),
        });
      };

      proc.on("close", (code) => finalizeNonTerminal(code));

      // Deterministic settle backstop. `close` only fires once EVERY fd on the
      // child's stdout pipe is gone — a grandchild a bash/shell tool left behind
      // (inheriting the pipe) can keep it open indefinitely, so a turn that never
      // emitted a parseable `end` marker would otherwise hang in "running" forever
      // (the empty/stuck outcome). `exit` fires when grok itself exits regardless of
      // that lingering pipe; we give a short grace for any final stdout to flush,
      // then force the same resolution. The `end`-marker path (settleOnTerminal)
      // stays primary and wins the `settled` race for normal turns — this only
      // catches crash/kill/no-end exits, so it never regresses the 94a50cc fix.
      proc.on("exit", (code) => {
        if (settled) return;
        const timer = setTimeout(() => finalizeNonTerminal(code), 1500);
        timer.unref?.();
      });

      proc.on("error", (err) => {
        if (settled) return;
        settled = true;
        stopTranscriptWatch();
        cleanupMcpOnce();
        this.liveProcesses.delete(trackingId);
        reject(new Error(`Failed to spawn Grok CLI: ${err.message}`));
      });
    });
  }

  private buildCleanEnv(sessionId?: string): Record<string, string> {
    const cleanEnv = buildEngineChildEnv(process.env, { scrubClaudeCode: true, scrubCodex: true });
    if (sessionId) cleanEnv.JINN_SESSION_ID = sessionId;
    cleanEnv.GROK_CLAUDE_MCPS_ENABLED = "false";
    cleanEnv.GROK_CURSOR_MCPS_ENABLED = "false";
    // GRS-012c: grok's OpenTelemetry trace exporter TLS-fails against its traces
    // endpoint (`BadRecordMac` → cli-chat-proxy.grok.com/v1/traces) and can CANCEL
    // a headless turn mid-run (observed with the jinn MCP server attached; the
    // probe's run-1 stderr proved the correlation, run-3 with OTEL disabled ran
    // clean → EndTurn). Disable the SDK for THIS jinn-spawned child only — this is
    // the child's env, never the operator's global shell, so a user's own `grok`
    // telemetry is unaffected (Fable memo-9 §2.1 acceptance property).
    cleanEnv.OTEL_SDK_DISABLED = "true";
    return cleanEnv;
  }

  private signalProcess(proc: ChildProcess, signal: NodeJS.Signals): void {
    if (proc.exitCode !== null) return;
    try {
      if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, signal);
      else proc.kill(signal);
    } catch (err) {
      logger.debug(`Failed to send ${signal} to Grok process: ${err instanceof Error ? err.message : err}`);
    }
  }
}
