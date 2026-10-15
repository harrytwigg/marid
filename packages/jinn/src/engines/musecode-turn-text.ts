import type { StreamDelta } from "../shared/types.js";
import { extractActivityReceiptId } from "../shared/activity-receipts.js";

/**
 * The pure parts of reading a Muse turn: typed values out of loose notification
 * params, and the words the live view shows for what happened.
 */

/**
 * What every result carries once the conversation exists: one turn, and an
 * explicit statement that it is intact. Muse reports no cost until a catalog
 * supplies rates, and its errors are provider text that can contain anything,
 * so neither may decide that a resumable conversation is dead.
 */
export const CONVERSATION_KEPT = { numTurns: 1, conversationIntact: true } as const;

/** What a model costs per million tokens, as the catalog (`model/list`) states it. */
export interface MuseModelCost {
  input: number;
  cached: number;
  output: number;
}

export interface TokenUsage {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** The turn's failure as the server states it. */
export interface MuseTurnError {
  kind: string;
  message: string;
  quota?: { limitKind: string; resetsAtMs: number };
  retryable?: boolean;
}

/** A tool call as it is built up over its started, updated and completed items. */
export interface ToolItem {
  announced: boolean;
  name: string | undefined;
  args: string | undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** "1s", "1.5s", "2m 5s": a retry delay for a status line. */
export function formatRetryDelay(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
  const whole = Math.round(seconds);
  const rest = whole % 60;
  return rest ? `${Math.floor(whole / 60)}m ${rest}s` : `${Math.floor(whole / 60)}m`;
}

/** The status line for a `turn/modelRetryScheduled`: what failed, and which try is next. */
export function describeModelRetry(params: Record<string, unknown>): string {
  const kind = (str(params.errorKind) ?? "error").replace(/_/g, " ");
  const http = num(params.httpStatus);
  const next = num(params.nextAttempt) ?? (num(params.attempt) ?? 0) + 1;
  const max = num(params.maxAttempts);
  const delay = num(params.retryDelayMs);
  return `Muse Code ${kind}${http === undefined ? "" : ` (HTTP ${http})`}; retry ${next}${max === undefined ? "" : `/${max}`}`
    + (delay === undefined ? "" : ` in ${formatRetryDelay(delay)}`);
}

/** A one-line summary of a tool call for the live view: its name and the thing it acts on. */
export function describeMuseToolCall(name: string | undefined, args: string | undefined): string {
  const tool = name ?? "tool";
  let parsed: Record<string, unknown> | undefined;
  if (args) {
    try {
      parsed = asRecord(JSON.parse(args));
    } catch {
      parsed = undefined;
    }
  }
  const detail = ["command", "path", "file_path", "filePath", "pattern", "query", "url"].map((k) => str(parsed?.[k])).find(Boolean);
  return detail ? `${tool}: ${detail}` : `Running ${tool}`;
}

/** USD for a turn's usage at a model's per-million-token rates. `cachedTokens` is read as a part of `inputTokens`. */
export function museTurnCost(usage: TokenUsage | undefined, rates: MuseModelCost | undefined): number | undefined {
  if (!usage || !rates) return undefined;
  const cached = Math.min(usage.cachedTokens, usage.inputTokens);
  const cost = ((usage.inputTokens - cached) * rates.input + cached * rates.cached + usage.outputTokens * rates.output) / 1_000_000;
  return cost > 0 ? cost : undefined;
}

export function numOr(value: unknown, fallback: number): number {
  return num(value) ?? fallback;
}

/** The server's failure object, or undefined when the turn carried none. */
export function parseTurnError(error: Record<string, unknown> | undefined, reason: string | undefined): MuseTurnError | undefined {
  if (!error) return undefined;
  const quota = asRecord(error.quota);
  const resetsAtMs = num(quota?.resetsAtMs);
  return {
    kind: str(error.kind) ?? "unknown",
    message: str(error.message) ?? reason ?? "Muse Code reported an error with no message",
    ...(quota && resetsAtMs !== undefined ? { quota: { limitKind: str(quota.limitKind) ?? "quota", resetsAtMs } } : {}),
    ...(typeof error.retryable === "boolean" ? { retryable: error.retryable } : {}),
  };
}

export function parseTokenUsage(usage: Record<string, unknown> | undefined): TokenUsage | undefined {
  if (!usage) return undefined;
  const cacheRead = num(usage.cacheReadTokens);
  const cacheWrite = num(usage.cacheWriteTokens);
  return {
    inputTokens: numOr(usage.inputTokens, 0),
    cachedTokens: numOr(usage.cachedTokens, 0),
    outputTokens: numOr(usage.outputTokens, 0),
    ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
  };
}

export function toolUseDelta(entry: ToolItem, toolId: string): StreamDelta {
  return {
    type: "tool_use",
    content: describeMuseToolCall(entry.name, entry.args),
    ...(entry.name ? { toolName: entry.name } : {}),
    toolId,
    ...(entry.args ? { input: entry.args.slice(0, 200) } : {}),
  };
}

/**
 * What a finished tool call shows. Muse's shell tool reports a JSON envelope
 * (`{"exit_code": 0, "output": "…", …}`); the output is what the live view wants,
 * and the exit code only when it is not zero.
 */
export function toolOutputText(visibleOutput: unknown, failureReason?: string): string {
  if (typeof visibleOutput !== "string") return failureReason ?? "";
  try {
    const envelope = asRecord(JSON.parse(visibleOutput));
    if (typeof envelope?.output === "string") {
      const code = num(envelope.exit_code);
      return code ? `${envelope.output}${envelope.output && !envelope.output.endsWith("\n") ? "\n" : ""}(exit code ${code})` : envelope.output;
    }
  } catch {
    /* not an envelope: show it as it is */
  }
  return visibleOutput;
}

export function toolResultDelta(entry: ToolItem, toolId: string, item: Record<string, unknown>, status: string): StreamDelta {
  const output = toolOutputText(item.visibleOutput, str(item.failureReason));
  const activityReceiptId = extractActivityReceiptId(output, { isError: status !== "completed" });
  return {
    type: "tool_result",
    content: output.slice(0, 500),
    ...(entry.name ? { toolName: entry.name } : {}),
    toolId,
    ...(activityReceiptId ? { activityReceiptId } : {}),
  };
}
