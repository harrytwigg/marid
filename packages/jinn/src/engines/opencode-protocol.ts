import type { EngineRunOpts } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { modelWithVariant, runVariantOf, variantOf, withoutVariantFlags } from "./opencode-variant.js";

/**
 * opencode's wire contract, as pure functions.
 *
 * The argv and the prompt live here rather than in the engine because BOTH
 * transports build them: a remote turn differs from a local one only in which
 * machine runs the command, and two copies of that list is how the two quietly
 * stop being the same turn. The event readers live here for the same reason the
 * grok engine keeps `grok-json.ts` beside it — pulling a value out of a
 * loosely-typed line is its own concern, separable from deciding what the line
 * MEANS.
 */

/** The prompt as opencode will receive it on stdin: the system prompt on a first
 *  turn, and any attachment paths appended. Shared by both transports so a remote
 *  turn cannot drift into being prompted differently from a local one.
 *
 *  Attachments are named in the text rather than passed to opencode's own `-f`,
 *  which is the same shape the Pi engine uses. A remote turn is handed the paths
 *  as its own staged home names them (see mapAttachmentsForRemote), because the
 *  gateway's paths name nothing on the other machine. */
export function buildOpencodePrompt(opts: EngineRunOpts): string {
  let prompt = opts.prompt;
  if (opts.systemPrompt && !opts.resumeSessionId) {
    prompt = `${opts.systemPrompt}\n\n---\n\n${prompt}`;
  }
  if (opts.attachments?.length) {
    prompt += `\n\nAttached files:\n${opts.attachments.map((a) => `- ${a}`).join("\n")}`;
  }
  return prompt;
}

/** Per-host facts that change a `run` turn's argv. */
export interface OpencodeRunFlags {
  standalone?: boolean;
  /** The binary's `run` has no `--variant`: the variant rides on the model
   *  (`-m provider/model#variant`). OpenCode 2's CLI. */
  variantOnModel?: boolean;
}

/** `--standalone` in any spelling: bare, with a value, or negated. */
function isStandaloneFlag(flag: string): boolean {
  return flag === "--standalone" || flag === "--no-standalone" || flag.startsWith("--standalone=");
}

/** `-m`, with the turn's variant (its effort level) where the binary takes one.
 *  Only an effort the model lists reaches here (see opencode-variant.ts). An
 *  operator's own `--variant` in cliFlags wins: a 1.x CLI gets it as the flag
 *  it is, and a 2.x CLI, which has no such flag, gets it on the model. */
function modelArgs(opts: EngineRunOpts, run: OpencodeRunFlags): string[] {
  if (!opts.model) return [];
  if (run.variantOnModel) return ["-m", modelWithVariant(opts.model, variantOf(opts))];
  const variant = runVariantOf(opts);
  return variant ? ["-m", opts.model, "--variant", variant] : ["-m", opts.model];
}

/**
 * opencode's argv, minus the prompt.
 *
 * Identical on both transports — the only thing a remote turn changes is which
 * machine runs it — so this is one list rather than two that drift.
 *
 * `--dangerously-skip-permissions` is how an unattended turn gets approval, and
 * it is deliberately the ONLY approval lever jinn pulls: it auto-approves
 * everything not EXPLICITLY denied, so an operator who denied `bash` in their
 * own opencode config still has that honoured. Forcing a `permission` block in
 * the staged config would silently take that away.
 */
export function buildOpencodeArgs(opts: EngineRunOpts, run: OpencodeRunFlags = {}): string[] {
  const args = ["run", "--format", "json", "--dangerously-skip-permissions"];
  // OpenCode 2's CLI starts (or joins) a background `serve --service` daemon
  // unless told not to. Older CLIs reject the flag, so only a host known to run
  // 2.x gets it. Whatever the operator's `cliFlags` say about it wins.
  if (run.standalone && !opts.cliFlags?.some(isStandaloneFlag)) args.push("--standalone");
  args.push(...modelArgs(opts, run));
  // opencode assigns its own session ids, so a resume names one it gave us on a
  // previous turn — unlike pi, where the id is ours and the same on every turn.
  if (opts.resumeSessionId) args.push("-s", opts.resumeSessionId);
  // A 2.x `run` rejects `--variant`; its value went on the model above.
  const flags = run.variantOnModel ? withoutVariantFlags(opts.cliFlags) : opts.cliFlags ?? [];
  args.push(...flags);
  // The prompt goes over stdin, never argv: `run` takes the message as trailing
  // positionals, so a prompt beginning with a dash would be read as a flag, and
  // a long one would run into ARG_MAX.
  return args;
}

/** `opencode serve`, bound to loopback on a port the caller already chose. The
 *  server is never exposed: the gateway reaches a remote one through an ssh
 *  `-L` forward, and it answers nothing without its per-session password. */
export function buildOpencodeServeArgs(port: number): string[] {
  return ["serve", "--port", String(port), "--hostname", "127.0.0.1"];
}

/** The terminal view: opencode's own TUI as a client of the session's server,
 *  opened on the session when there is one yet. OpenCode 2 has no `attach`:
 *  its TUI takes `--server` (and reads the password from
 *  `OPENCODE_SERVER_PASSWORD`, as 1.x's attach does). */
export function buildOpencodeViewArgs(serverUrl: string, engineSessionId?: string, api: 1 | 2 = 1): string[] {
  const session = engineSessionId ? ["-s", engineSessionId] : [];
  return api === 2 ? ["--server", serverUrl, ...session] : ["attach", serverUrl, ...session];
}

/** The model and variant, for a log line. */
export function describeOpencodeLaunch(opts: EngineRunOpts): string {
  const variant = variantOf(opts);
  return `-m ${opts.model || "(opencode default)"}${variant && opts.model ? ` (variant ${variant})` : ""}`;
}

/** The `tokens` block of a `step_finish` part, as far as we rely on it. */
export interface StepTokens {
  input?: number;
  output?: number;
  cache?: { read?: number; write?: number };
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * How full the context window is after this step: everything opencode counted
 * as INPUT, cached or not. Matches {@link EngineResult.contextTokens}, which is
 * defined as input + cache-read + cache-creation.
 */
export function contextTokensFromStep(tokens: StepTokens | undefined): number | undefined {
  if (!tokens) return undefined;
  const cache = tokens.cache ?? {};
  const total = numberOr(tokens.input, 0) + numberOr(cache.read, 0) + numberOr(cache.write, 0);
  return total > 0 ? total : undefined;
}

export function trimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** One stdout line as an event object, or undefined when it is not one. */
export function parseEventLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    logger.debug(`[opencode stream] unparseable line: ${trimmed.slice(0, 100)}`);
    return undefined;
  }
}

/** The tool name and call id a `tool_use` part carries, shaped for a StreamDelta
 *  spread so the start and the result cannot disagree about which call they are. */
export function toolIdentity(part: Record<string, unknown>): { toolName?: string; toolId?: string } {
  const toolName = trimmedString(part.tool);
  const toolId = trimmedString(part.callID);
  return { ...(toolName ? { toolName } : {}), ...(toolId ? { toolId } : {}) };
}

/** A one-line summary of a tool call for the live view. The three input keys are
 *  the ones opencode's own built-in tools use for the thing being acted on. */
export function describeToolCall(toolName: string | undefined, input: Record<string, unknown> | undefined): string {
  const detail = [input?.filePath, input?.command, input?.path].map(trimmedString).find(Boolean);
  return detail ? `${toolName ?? "tool"}: ${detail}` : `Running ${toolName ?? "tool"}`;
}

/** How much of an unreadable error event is kept in EngineResult.error. */
const RAW_ERROR_LIMIT = 500;

/**
 * The message an `error` event carries, as a single line for EngineResult.error.
 *
 * 1.x prints `{name, data: {message}}`. OpenCode 2's `opencode run` prints
 * `{type, message, status?}` unconverted, and is read the way `v2ErrorLine`
 * reads it for a server turn, so one failure says the same thing on either
 * path. An event that has neither shape is quoted rather than dropped: an
 * opaque "no message" is something nobody can act on.
 */
export function opencodeErrorText(event: Record<string, unknown>): string {
  const bare = trimmedString(event.error);
  if (bare) return bare;
  const error = asRecord(event.error);
  const readable = error && readableErrorText(error);
  if (readable) return readable;
  // The envelope every line carries says nothing about the failure, and its
  // digits must not reach failure classification: a timestamp or session id
  // containing "429" would read as a rate limit. An id inside the error object
  // itself can still do that; the classifier, not this quote, is where to fix it.
  const { type: _type, sessionID: _sessionID, timestamp: _timestamp, ...rest } = error ?? event;
  if (Object.keys(rest).length === 0) return "opencode reported an error with no message and nothing else in its event";
  const raw = JSON.stringify(rest);
  const quoted = raw.length > RAW_ERROR_LIMIT ? `${raw.slice(0, RAW_ERROR_LIMIT)}…` : raw;
  return `opencode reported an error with no message: ${quoted}`;
}

/** The error object read as 1.x's or OpenCode 2's; undefined when it is neither. */
function readableErrorText(error: Record<string, unknown>): string | undefined {
  return v1ErrorText(error) ?? v2ErrorText(error);
}

/** 1.x's `{name, data: {message}}` as `name: message`. */
function v1ErrorText(error: Record<string, unknown>): string | undefined {
  const message = trimmedString(asRecord(error.data)?.message);
  const name = trimmedString(error.name);
  return message && name ? `${name}: ${message}` : message ?? name;
}

/** OpenCode 2's `{type, message, status?}` in exactly the text `v2ErrorLine`
 *  gives it on a server turn. */
function v2ErrorText(error: Record<string, unknown>): string | undefined {
  const type = trimmedString(error.type);
  const message = trimmedString(error.message);
  if (!type && !message) return undefined;
  const status = typeof error.status === "number" ? ` (HTTP ${error.status})` : "";
  return `${type ?? "error"}: ${message ?? "no message"}${status}`;
}
