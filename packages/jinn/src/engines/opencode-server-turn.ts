import type { EngineResult, EngineRunOpts, StreamDelta } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { OpencodeTurn } from "./opencode-turn.js";
import { buildOpencodePrompt } from "./opencode-protocol.js";
import { basicAuthHeader, type OpencodeServer } from "./opencode-server.js";
import { USER_STOP_INTERRUPTION_REASON } from "../sessions/interruption-reasons.js";

/**
 * One Jinn turn, sent straight to the session's opencode server over HTTP.
 *
 * Not `opencode run --attach`, although that was the first design: opencode
 * 1.18.31's attached client prints `step_start` and exits 0 before the answer
 * whenever the session's directory is not a git repository (5/5 reproduced on
 * build-host, 0/5 in a repo; `--dir` does not help), while the server itself
 * finishes the turn correctly. A remote employee's working root is exactly such
 * a directory. So Jinn is the client:
 *
 *   1. subscribe to the server's `/event` stream, and wait for it to connect;
 *   2. create the opencode session, or resume the one named;
 *   3. POST the prompt with `prompt_async`;
 *   4. translate the stream until the turn's own reply is done — or, failing
 *      that, until the session goes idle.
 *
 * Step 4 turns each event into the line `opencode run --format json` would
 * have printed for it — those lines are `{type, sessionID, part}` around the
 * very Part objects the server sends here — and feeds it to `OpencodeTurn`.
 * So what a turn MEANS (the answer, tool calls, accounting, errors, rate-limit
 * classification) is still decided by the same parser as in `run` mode.
 *
 * Approval matches `opencode run --dangerously-skip-permissions`: a permission
 * the server asks about is granted once, and anything explicitly denied in the
 * operator's config is refused by the server without asking. The `question`
 * tool (the model asking the user to choose) is switched off for the prompt,
 * because `opencode run` does not offer it either — verified on 1.18.31: under
 * `run` the model reports it has no such tool, and with `tools: {question:
 * false}` a server turn behaves the same. A question that still arrives (from
 * a sub-session the switch did not reach) is rejected, since nobody is there to
 * answer.
 *
 * Everything above is scoped to THIS TURN'S OWN MESSAGES, not to the opencode
 * session: the operator can put a prompt into the very same session from the
 * terminal, and opencode then runs it in the same busy period. So the turn
 * posts its prompt under a message id it generated, and only assistant
 * messages whose `parentID` is that id — and the sub-sessions they spawn —
 * count as the turn's: their parts are its answer and their permission prompts
 * are its to grant. Anything else in the session is someone else's.
 *
 * One thing crosses that line on purpose: a request the operator STOPPED. A
 * prompt the operator typed and then Esc-aborted stays in the session's history
 * unanswered, and a model reads the next prompt as a follow-up to it (* 10 of 11 live runs carried an aborted read out in the next Jinn turn's own
 * reply, with that turn's permissions granted). So before posting, a resumed
 * turn reads the session's recent history, and if it ends in requests the
 * operator cancelled, the prompt carries a synthetic part telling the model so
 * (the operator's chosen fix: tell the model, rather than refuse the
 * turn's permissions or revert the operator's messages). Jinn's own prompts are
 * told apart by the metadata they are posted with.
 *
 * A Jinn prompt the user stopped (the chat's Stop, or a parent session's
 * stop_session) is left in the history the same way, and a model carries that
 * out too. Jinn also stops its own turns for reasons that are not the
 * user's — a restart, a timeout, a new message cutting in — so the reason is
 * recorded where the next turn will read it: once a stop by the user has
 * aborted the turn, the turn marks its prompt in opencode's store as stopped by
 * the user, and the next turn names it with the others.
 */

/** What an abort has to stop: the turn's opencode session, and the message
 *  the turn posted there (so a reply to it can be checked for having ended). */
export interface AbortTarget {
  engineSessionId: string;
  userMessageId: string;
}

export interface ServerTurnDeps {
  /** Stop this turn on the server and wait until it has (the pool's
   *  abortTurn). An interrupt calls this; closing our stream would not stop it. */
  abort: (target: AbortTarget) => Promise<void>;
  /** Told when the turn learns which opencode session it runs in. */
  onSessionId?: (engineSessionId: string) => void;
  /** Told when the server's events stopped matching what this turn reads: a
   *  finished turn whose answer is in the server's store but never arrived on
   *  the stream, or an idle that never arrived. The engine takes the host off
   *  server mode, so later turns use `run` rather than lose events silently. */
  onProtocolDrift?: (reason: string) => void;
}

/** Timings a test may shorten. The status poll is a backstop for a
 *  `session.idle` that never arrives; two idle answers in a row, after the
 *  prompt has had time to start, are needed before it counts. The connect
 *  budget covers only opening the stream: the pool hands out a server once its
 *  instance has bootstrapped, which is the slow part. */
export const SERVER_TURN_TIMING = { statusPollMs: 30_000, connectMs: 15_000 };

/** A parsed SSE event from the server's `/event` stream. */
interface ServerEvent {
  type: string;
  properties?: Record<string, unknown>;
}

const TURN_TIMEOUT_MS = 14 * 24 * 60 * 60 * 1000;
/** How many of the session's newest messages a resumed turn reads before it
 *  posts: enough to reach back past a long multi-step reply. */
const HISTORY_LIMIT = 100;
/** How much of one cancelled request the notice quotes. */
const QUOTE_LIMIT = 500;

/** Metadata on every text part Jinn posts, which is how a later turn tells
 *  Jinn's prompts in the history from the operator's. opencode stores a text
 *  part's metadata and returns it with the message (verified on 1.18.32). */
export const JINN_PROMPT_METADATA = { jinn: "prompt" } as const;
const JINN_NOTICE_METADATA = { jinn: "cancelled-requests" } as const;
const JINN_STOPPED_NOTICE_METADATA = { jinn: "stopped-requests" } as const;
/** How long marking a stopped prompt may hold up the stop. */
const MARK_TIMEOUT_MS = 5_000;

/** The turn's error when the session went idle without ever running its prompt. */
const PROMPT_NOT_RUN = {
  name: "PromptNotRun",
  data: { message: "opencode went idle without running this turn's prompt (an abort in the session drops the prompts queued behind it)" },
};
const REQUEST_TIMEOUT_MS = 30_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** `provider/model` as the prompt API takes it. The model half may itself
 *  contain slashes (`openrouter/meta-llama/llama-4`); only the first one splits. */
export function promptModel(model: string | undefined): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return undefined;
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

/** `--agent <name>` from the operator's cliFlags — the one run flag with a
 *  prompt-API equivalent. Anything else is logged and ignored. */
export function agentFromCliFlags(flags: string[] | undefined): string | undefined {
  if (!flags?.length) return undefined;
  const i = flags.indexOf("--agent");
  return i >= 0 ? str(flags[i + 1]) : undefined;
}

/** The `run` line for a part, keyed by part type; undefined = `run` prints nothing. */
const PART_LINES: Record<string, (part: Record<string, unknown>) => string | undefined> = {
  "step-start": () => "step_start",
  "step-finish": () => "step_finish",
  // `run` prints a text part once, when it is complete.
  text: (part) => (record(part.time)?.end !== undefined && typeof part.text === "string" && part.text ? "text" : undefined),
  // `run` prints a tool call once it has a result, as does this.
  tool: (part) => {
    const status = str(record(part.state)?.status);
    return status === "completed" || status === "error" ? "tool_use" : undefined;
  },
};

function errorLine(props: Record<string, unknown>, sessionId: string): string | undefined {
  if (props.sessionID !== sessionId) return undefined;
  const error = record(props.error);
  return error ? JSON.stringify({ type: "error", sessionID: sessionId, error }) : undefined;
}

function partLine(props: Record<string, unknown>, sessionId: string): string | undefined {
  const part = record(props.part);
  if (!part || part.sessionID !== sessionId) return undefined;
  const type = PART_LINES[str(part.type) ?? ""]?.(part);
  return type ? JSON.stringify({ type, sessionID: sessionId, part }) : undefined;
}

/**
 * The `opencode run --format json` line for one server event, or undefined when
 * `run` would print nothing for it. Pure, so the translation is testable
 * against real captured events.
 */
export function runLineForEvent(event: ServerEvent, sessionId: string): string | undefined {
  const props = record(event.properties) ?? {};
  if (event.type === "session.error") return errorLine(props, sessionId);
  if (event.type === "message.part.updated") return partLine(props, sessionId);
  return undefined;
}

/**
 * Whether an assistant message ends its turn: completed, with a finish reason
 * other than a tool round trip — opencode's own loop-exit condition (1.18.31:
 * `finish && !["tool-calls","unknown"].includes(finish)`). The turn ends on
 * THIS rather than on the session going idle, because the session stays busy
 * for as long as anything queued after the turn runs — including someone
 * else's prompt waiting on a permission nobody has answered yet.
 */
export function replyIsDone(info: Record<string, unknown>): boolean {
  const finish = str(info.finish);
  return Boolean(record(info.time)?.completed) && Boolean(finish) && finish !== "tool-calls" && finish !== "unknown";
}

/** A line that answers the turn: its text, or its error. */
function isAnswerLine(line: string): boolean {
  return /^\{"type":"(text|error)"/.test(line);
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let idCounter = 0;

/**
 * A message id in opencode's own format: `msg_`, twelve hex digits of
 * `(ms * 0x1000 + counter) mod 2^48`, and fourteen random base62 characters —
 * ascending, like the ids the server makes itself, so a message posted under
 * it sorts where it should. Verified on 1.18.31: `prompt_async` accepts it, the
 * user message takes it, and the reply's `parentID` names it.
 */
export function newMessageId(now = Date.now()): string {
  idCounter = (idCounter + 1) % 0x1000;
  const stamp = ((BigInt(now) * 0x1000n + BigInt(idCounter)) % (1n << 48n)).toString(16).padStart(12, "0");
  let random = "";
  for (let i = 0; i < 14; i++) random += BASE62[Math.floor(Math.random() * 62)];
  return `msg_${stamp}${random}`;
}

/**
 * The `run` lines for a turn's stored replies — the recovery path when the
 * stream did not deliver them. Only assistant messages answering `userMessageId`
 * are the turn's; the stored parts are the same Part objects the stream
 * carries, so the translation is the same one.
 */
export function runLinesFromMessages(
  messages: StoredMessage[],
  sessionId: string,
  userMessageId: string,
): string[] {
  const lines: string[] = [];
  for (const message of messages.filter((m) => m.info?.role === "assistant" && m.info.parentID === userMessageId)) {
    for (const part of message.parts ?? []) {
      const line = runLineForEvent({ type: "message.part.updated", properties: { part } }, sessionId);
      if (line) lines.push(line);
    }
    const error = record(message.info?.error);
    if (error) lines.push(JSON.stringify({ type: "error", sessionID: sessionId, error }));
  }
  return lines;
}

type StoredMessage = { info?: Record<string, unknown>; parts?: unknown[] };

function textParts(message: StoredMessage): Array<Record<string, unknown>> {
  return (message.parts ?? []).map(record).filter((p): p is Record<string, unknown> => p?.type === "text");
}

/** A prompt Jinn posted (it marks every text part it sends). */
function isJinnPrompt(message: StoredMessage): boolean {
  return textParts(message).some((p) => record(p.metadata)?.jinn !== undefined);
}

/** What the user typed: the message's text, less anything opencode added. */
function requestText(message: StoredMessage): string {
  return textParts(message).filter((p) => !p.synthetic && typeof p.text === "string").map((p) => p.text as string).join("\n").trim();
}

/** The metadata of a Jinn prompt's own text part (the one {@link JINN_PROMPT_METADATA} marks). */
function jinnPromptMetadata(message: StoredMessage): Record<string, unknown> | undefined {
  return textParts(message).map((p) => record(p.metadata)).find((m) => m?.jinn === JINN_PROMPT_METADATA.jinn);
}

/** A Jinn prompt the user stopped: marked so by the turn the stop ended. */
function isStoppedByUser(message: StoredMessage): boolean {
  return jinnPromptMetadata(message)?.stopped === "user";
}

/** What a stopped Jinn prompt asked: the request the turn recorded when it was
 *  stopped, even an empty one (a first turn's text also carries the system
 *  prompt, which is never what to quote), or else its text. */
function stoppedRequestText(message: StoredMessage): string {
  const request = jinnPromptMetadata(message)?.request;
  if (typeof request !== "string") return requestText(message);
  return request.trim() || "(a request with no text)";
}

/** A Jinn prompt that carried a notice: everything older was named there, and
 *  the model still has that notice in the history it reads. */
function carriedNotice(message: StoredMessage): boolean {
  return textParts(message).some((p) => p.synthetic && record(p.metadata)?.jinn !== undefined);
}

/** What the history says was cancelled, oldest first in each list: the
 *  operator's requests aborted in opencode itself, and Jinn prompts
 *  the user stopped. */
export interface CancelledRequests {
  cancelled: string[];
  stopped: string[];
}

/**
 * The requests the session's history ends in that were cancelled. First, the
 * operator's own (`cancelled`):
 * the newest reply to each was aborted, or there is no reply at all because an
 * abort dropped them while they were queued (verified on 1.18.32: an
 * operator's follow-up typed while their prompt waited on a permission, then
 * Esc; the follow-up keeps no reply, and the next turn's model carried it out
 * in 4/4 runs). Dropped means: no reply, the session idle, and created before
 * an abort ended. A prompt created after it — one opencode has not picked up
 * yet (that takes up to ~700 ms), or one that failed before any reply — was not
 * dropped by it. Oldest first. Walking back from the newest user message:
 *
 * - such an operator request is collected;
 * - a Jinn prompt the user stopped, that was aborted or never got a reply, is
 *   collected too, as `stopped`: its turn marked it so;
 * - any other Jinn prompt that was aborted or never got a reply is stepped
 *   over. Jinn stops its own turns for reasons that are not the user's (a
 *   restart, a timeout, a new message), so it never calls one of them
 *   cancelled — and a Jinn prompt dropped by the same abort (it was queued
 *   behind the operator's) must not hide the request that was;
 * - anything else ends the walk: a request that was answered, failed some other
 *   way, is still running, or (the session busy) waits to run is not a
 *   cancelled one;
 * - and past a Jinn prompt that carried a notice, only what was cancelled after
 *   that prompt was made is still collected: whatever was cancelled before it
 *   was named there once, and is still in front of the model, so the walk ends
 *   at the first such request. Naming it again after, say, a restart cut that
 *   turn short would contradict a "continue" the user has since given. A
 *   request cancelled after it — the operator's, typed between that prompt's
 *   history read and its post, then aborted by the Esc that also dropped the
 *   prompt — its notice could not have named.
 */
export function cancelledRequests(messages: StoredMessage[], sessionBusy: boolean): CancelledRequests {
  const replies = newestReplies(messages);
  const abortEnds = abortEndsOf(messages);
  const abortEnd = sessionBusy ? 0 : Math.max(0, ...abortEnds);
  const found: CancelledRequests = { cancelled: [], stopped: [] };
  /** When the newest prompt that carried a notice was made (0: none yet). */
  let noticedAt = 0;
  for (const message of messages.filter((m) => m.info?.role === "user").reverse()) {
    const reply = replies.get(str(message.info?.id) ?? "");
    const step = walkStep(message, reply, abortEnd);
    if (step === "stop") break;
    if (step !== "skip") {
      if (noticedAt && cancelledAt(message, reply, abortEnds) <= noticedAt) break;
      collect(found, step, message);
    }
    noticedAt ||= noticeTime(message);
  }
  return found;
}

/** When a request was cancelled: its reply's end, or, with no reply, the end of
 *  the first abort after it was made — the one that dropped it. Not the newest
 *  abort: a later one (a restart cutting a turn short) did not cancel it. */
function cancelledAt(message: StoredMessage, reply: Record<string, unknown> | undefined, abortEnds: number[]): number {
  if (reply) return timeOf(reply, "completed");
  const created = timeOf(message.info, "created");
  const after = abortEnds.filter((end) => end >= created);
  // No abort after it on record: it was cancelled before the notice, which named it.
  return after.length ? Math.min(...after) : 0;
}

/** When a prompt that carried a notice was made; 0 for any other message. */
function noticeTime(message: StoredMessage): number {
  return carriedNotice(message) ? timeOf(message.info, "created") || Number.POSITIVE_INFINITY : 0;
}

function collect(found: CancelledRequests, step: "cancelled" | "stopped", message: StoredMessage): void {
  const text = step === "stopped" ? stoppedRequestText(message) : requestText(message);
  if (text) found[step].unshift(text);
}

/** Each user message's newest reply, by the message it answers. */
function newestReplies(messages: StoredMessage[]): Map<string, Record<string, unknown>> {
  const replies = new Map<string, Record<string, unknown>>();
  for (const info of messages.map((m) => m.info)) {
    const parent = str(info?.parentID);
    if (!info || info.role !== "assistant" || !parent) continue;
    if ((str(info.id) ?? "") >= (str(replies.get(parent)?.id) ?? "")) replies.set(parent, info);
  }
  return replies;
}

function isAborted(info: Record<string, unknown> | undefined): boolean {
  return str(record(info?.error)?.name) === "MessageAbortedError";
}

function timeOf(info: Record<string, unknown> | undefined, key: "created" | "completed"): number {
  const value = record(info?.time)?.[key];
  return typeof value === "number" ? value : 0;
}

/** When each aborted reply in the history ended. */
function abortEndsOf(messages: StoredMessage[]): number[] {
  return messages.map((m) => m.info).filter(isAborted).map((info) => timeOf(info, "completed"));
}

/** One step of the walk in {@link cancelledRequests}. `abortEnd` is 0 while the
 *  session is busy: then a request with no reply may still be waiting to run. */
function walkStep(
  message: StoredMessage,
  reply: Record<string, unknown> | undefined,
  abortEnd: number,
): "cancelled" | "stopped" | "skip" | "stop" {
  const aborted = isAborted(reply);
  if (isJinnPrompt(message)) {
    if (reply && !aborted) return "stop";
    return isStoppedByUser(message) ? "stopped" : "skip";
  }
  const created = timeOf(message.info, "created");
  const dropped = !reply && created > 0 && created <= abortEnd;
  return aborted || dropped ? "cancelled" : "stop";
}

/** What the model is told about requests the user cancelled. */
export function cancelledRequestsNotice(requests: string[]): string {
  return [
    "[Jinn] Before this message, the user cancelled the request(s) below by stopping them before they were answered:",
    "",
    quoteRequests(requests),
    "",
    "They were cancelled on purpose. Do not carry them out, continue them, or answer them, unless the final message, after these notes, asks for that again. Reply only to that final message.",
  ].join("\n");
}

/**
 * What the model is told about Jinn prompts the user stopped. Unlike
 * a request cancelled in the terminal, the message after a Stop comes from the
 * same person in the same conversation, so a "continue" there means the
 * stopped request, and is let through. Both notices point at "the final
 * message", not "the message below": when both are posted, what is below the
 * first is the second.
 */
export function stoppedRequestsNotice(requests: string[]): string {
  return [
    "[Jinn] Before this message, the user stopped the request(s) below before they were finished:",
    "",
    quoteRequests(requests),
    "",
    "They stopped them on purpose. Do not carry them out or pick them back up on your own. Do that only if the final message, after these notes, asks you to, for example by asking you to continue or try again; otherwise reply only to that final message.",
  ].join("\n");
}

/** Each request as a quote, long ones cut. */
function quoteRequests(requests: string[]): string {
  return requests.map((request) => {
    const text = request.length > QUOTE_LIMIT ? `${request.slice(0, QUOTE_LIMIT)}…` : request;
    return text.split("\n").map((line) => `> ${line}`).join("\n");
  }).join("\n\n");
}

/** The newest reply in the history that is still running, if any. */
function runningReply(messages: StoredMessage[]): string | undefined {
  const running = messages
    .map((m) => m.info)
    .filter((info) => info?.role === "assistant" && !record(info.time)?.completed && !info.error)
    .map((info) => str(info?.id) ?? "")
    .sort();
  return running.at(-1) || undefined;
}

/** Split an SSE buffer into complete events and the unfinished remainder. */
export function drainSseEvents(buffer: string): { events: ServerEvent[]; rest: string } {
  const events: ServerEvent[] = [];
  const chunks = buffer.split("\n\n");
  const rest = chunks.pop() ?? "";
  for (const chunk of chunks) {
    const data = chunk.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
    if (!data) continue;
    try {
      events.push(JSON.parse(data) as ServerEvent);
    } catch {
      logger.debug(`[opencode server] unparseable event: ${data.slice(0, 100)}`);
    }
  }
  return { events, rest };
}

export class OpencodeServerTurn {
  private readonly turn: OpencodeTurn;
  private readonly controller = new AbortController();
  private sessionId = "";
  /** The id this turn's prompt is posted under; its replies name it as parent. */
  private readonly userMessageId = newMessageId();
  /** Assistant messages answering this turn, and ones answering someone else. */
  private readonly own = new Set<string>();
  private readonly foreign = new Set<string>();
  /** Parts that arrived before their message said whose it is. */
  private readonly pendingParts = new Map<string, ServerEvent[]>();
  /** The newest assistant message in the session: whose step is running now. */
  private activeAssistant = "";
  /** Sub-sessions this turn's replies spawned (a subagent's), transitively. */
  private readonly children = new Set<string>();
  private sawBusy = false;
  private terminationReason: string | null = null;
  private failure: string | null = null;
  private settled = false;
  private resolveDone!: () => void;
  private readonly done = new Promise<void>((resolve) => { this.resolveDone = resolve; });
  /** Tool calls already reported at a given status, so a part re-sent at the
   *  same status (the server resends on every metadata change) is not doubled. */
  private readonly toolSeen = new Set<string>();
  private interrupting?: Promise<void>;
  /** The prompt's POST, while in flight; `posted` once the server has it. */
  private posting?: Promise<unknown>;
  private posted = false;
  /** A text or error line reached the parser from the stream. */
  private answered = false;
  /** The status poll, not the stream, noticed the turn end. */
  private missedIdle = false;
  private statusPoll?: NodeJS.Timeout;

  constructor(
    private readonly server: OpencodeServer,
    private readonly opts: EngineRunOpts,
    private readonly onStream: ((delta: StreamDelta) => void) | null,
    private readonly deps: ServerTurnDeps,
  ) {
    this.turn = new OpencodeTurn(opts.resumeSessionId || "");
  }

  /**
   * Stop the turn: on the server first, then here. Idempotent.
   *
   * A prompt still being posted is waited for, and one that never reached the
   * server needs nothing stopped. Otherwise the pool's abortTurn keeps
   * aborting this turn's session until the server has stayed quiet long
   * enough to be sure — an abort that lands before opencode has picked the
   * prompt up is silently lost (verified on 1.18.31), so one call is not enough.
   */
  interrupt(reason: string): Promise<void> {
    if (this.interrupting) return this.interrupting;
    this.terminationReason = reason;
    this.interrupting = this.stopOnServer()
      .then(() => (reason === USER_STOP_INTERRUPTION_REASON ? this.markStoppedByUser() : undefined))
      .finally(() => this.finish());
    return this.interrupting;
  }

  isSettled(): boolean {
    return this.settled;
  }

  async run(): Promise<EngineResult> {
    const timeout = setTimeout(() => void this.interrupt("opencode turn timed out"), TURN_TIMEOUT_MS);
    timeout.unref?.();
    try {
      await this.drive();
    } catch (err) {
      await this.fail(err);
    } finally {
      clearTimeout(timeout);
      if (this.statusPoll) clearInterval(this.statusPoll);
      this.controller.abort();
    }
    return this.turn.result({
      code: this.failure ? 1 : 0,
      terminationReason: this.terminationReason,
      stderr: this.failure ?? "",
    });
  }

  private async drive(): Promise<void> {
    await this.openStream();
    if (!this.settled) await this.start();
    await this.done;
    if (this.interrupting) await this.interrupting;
    if (this.statusPoll) clearInterval(this.statusPoll);
    // The stream dropped mid-turn: the server may still be working on it.
    if (this.failure && !this.terminationReason) await this.stopOnServer();
    if (!this.failure && !this.terminationReason && (!this.answered || this.missedIdle)) await this.recover();
  }

  private async fail(err: unknown): Promise<void> {
    if (!this.terminationReason) {
      this.failure = `opencode server turn failed: ${err instanceof Error ? err.message : String(err)}`;
      // Whatever we sent may still be running over there; stop it before the
      // next turn can start beside it.
      await this.stopOnServer();
    }
    this.finish();
  }

  private async stopOnServer(): Promise<void> {
    if (this.posting) await this.posting.catch(() => undefined);
    if (!this.posted) return;
    await this.deps.abort({ engineSessionId: this.sessionId, userMessageId: this.userMessageId }).catch(() => undefined);
  }

  /**
   * Record on the prompt itself, in opencode's store, that the user stopped it
   *: it survives a gateway restart, and the next turn's history walk
   * reads it. It is part of the interrupt, and `run()` does not return until
   * the interrupt has (drive awaits it) — the turn may already count as
   * settled, but the next turn of the session queues behind this `run()`, so
   * it finds the mark. Best effort: without it the next turn is simply not
   * told, as before. Verified on 1.18.32: `PATCH …/part/:partID` with the
   * stored part and new metadata keeps the text, and the next prompt runs.
   */
  private async markStoppedByUser(): Promise<void> {
    if (!this.posted) return;
    const route = `/session/${encodeURIComponent(this.sessionId)}/message/${encodeURIComponent(this.userMessageId)}`;
    const signal = AbortSignal.timeout(MARK_TIMEOUT_MS); // the read and the write together
    try {
      const message = record(await this.request("GET", route, undefined, signal)) as StoredMessage | undefined;
      const part = textParts(message ?? {}).find((p) => record(p.metadata)?.jinn === JINN_PROMPT_METADATA.jinn);
      const partId = str(part?.id);
      if (!part || !partId) throw new Error("the stored prompt has no Jinn text part");
      const metadata = { ...record(part.metadata), stopped: "user", request: this.opts.prompt.slice(0, QUOTE_LIMIT + 1) };
      await this.request("PATCH", `${route}/part/${encodeURIComponent(partId)}`, { ...part, metadata }, signal);
    } catch (err) {
      logger.warn(`opencode server turn could not mark its stopped prompt in ${this.sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Steps ────────────────────────────────────────────────────────────────

  /** Subscribe to the server's events; resolves once the server says so. */
  private openStream(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the event stream did not connect")), SERVER_TURN_TIMING.connectMs);
      timer.unref?.();
      void (async () => {
        const res = await fetch(`${this.server.apiUrl}/event`, {
          headers: { authorization: basicAuthHeader(this.server.password), accept: "text/event-stream" },
          signal: this.controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`GET /event answered ${res.status}`);
        await this.readStream(res.body, () => {
          clearTimeout(timer);
          resolve();
        });
        // The stream ended on its own: the server went away mid-turn.
        if (!this.settled && !this.terminationReason) {
          this.failure = "the opencode server closed the event stream mid-turn";
          this.finish();
        }
      })().catch((err) => {
        clearTimeout(timer);
        if (this.controller.signal.aborted) return;
        if (!this.settled) {
          this.failure = `lost the opencode server's event stream: ${err instanceof Error ? err.message : String(err)}`;
          this.finish();
        }
        reject(err);
      });
    });
  }

  private async start(): Promise<void> {
    this.sessionId = this.opts.resumeSessionId || await this.createSession();
    // Every later line names it; this one makes sure a turn that fails before
    // producing anything still reports the session it failed in.
    this.turn.readLine(JSON.stringify({ type: "session", sessionID: this.sessionId }), null);
    this.deps.onSessionId?.(this.sessionId);
    // Interrupted while the session was being made, or its history read: post
    // nothing. No await between the second check and `posting` being set, so
    // an interrupt either sees the post in flight or finds a check stopped it.
    if (this.terminationReason) return;
    const found = this.opts.resumeSessionId ? await this.readHistory() : undefined;
    if (this.terminationReason) return;
    this.posting = this.post(`/session/${encodeURIComponent(this.sessionId)}/prompt_async`, this.promptBody(found));
    await this.posting;
    this.posted = true;
    this.armStatusPoll();
  }

  /**
   * Before a resumed turn posts, what its session's history says it must know:
   * requests the operator cancelled (returned, for the prompt to name), and a
   * reply someone else started before this turn subscribed, which is still
   * running. The stream only shows a reply from its first event on, so without
   * this an error ending that reply would pass for this turn's own, and the
   * idle ending the busy period would be ignored for want of a busy.
   *
   * Best effort: a history that cannot be read costs the notice, not the turn.
   * A session the server does not know fails on the post, as before.
   */
  private async readHistory(): Promise<CancelledRequests | undefined> {
    let history: StoredMessage[];
    let busy: boolean;
    try {
      [history, busy] = await Promise.all([this.messages(HISTORY_LIMIT), this.isBusy()]);
    } catch (err) {
      logger.warn(`opencode server turn could not read session ${this.sessionId}'s history: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
    // The session went busy before the turn subscribed; the idle ending that
    // busy period — which this turn's prompt joins — still ends the turn. Only
    // then is an unfinished reply really running: a server killed mid-reply
    // leaves one behind with no completion and no error (verified on 1.18.32).
    const running = busy ? runningReply(history) : undefined;
    if (busy) this.sawBusy = true;
    if (running) {
      if (!this.own.has(running) && !this.foreign.has(running)) this.classify(running, false);
      if (running > this.activeAssistant) this.activeAssistant = running;
    }
    const found = cancelledRequests(history, busy);
    const count = found.cancelled.length + found.stopped.length;
    if (count) logger.info(`opencode server turn tells the model ${count} request(s) were cancelled or stopped in ${this.sessionId}`);
    return found;
  }

  /** The session's stored messages, as the server keeps them: the newest
   *  `limit` of them, oldest first, if a limit is given. */
  private async messages(limit?: number): Promise<StoredMessage[]> {
    const query = limit ? `?limit=${limit}` : "";
    const res = await fetch(`${this.server.apiUrl}/session/${encodeURIComponent(this.sessionId)}/message${query}`, {
      headers: { authorization: basicAuthHeader(this.server.password) },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`GET /session/…/message answered ${res.status}`);
    const body = await res.json() as unknown;
    return Array.isArray(body) ? body as StoredMessage[] : [];
  }

  /** Whether the server lists the turn's session as busy (it lists only those). */
  private async isBusy(): Promise<boolean> {
    const res = await fetch(`${this.server.apiUrl}/session/status`, {
      headers: { authorization: basicAuthHeader(this.server.password) },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`GET /session/status answered ${res.status}`);
    const status = record(await res.json());
    if (!status) throw new Error("GET /session/status answered something other than an object");
    return Boolean(record(status[this.sessionId]));
  }

  /** Backstop for a turn end the stream never announced (see SERVER_TURN_TIMING). */
  private armStatusPoll(): void {
    let idleAnswers = 0;
    this.statusPoll = setInterval(() => {
      void (async () => {
        const res = await fetch(`${this.server.apiUrl}/session/status`, {
          headers: { authorization: basicAuthHeader(this.server.password) },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const status = record(await res.json());
        idleAnswers = status && !record(status[this.sessionId]) ? idleAnswers + 1 : 0;
        if (idleAnswers >= 2 && !this.settled) {
          this.missedIdle = true;
          this.finish();
        }
      })().catch(() => { /* the stream's own failure handling covers a dead server */ });
    }, SERVER_TURN_TIMING.statusPollMs);
    this.statusPoll.unref?.();
  }

  /**
   * After a turn that went idle with neither an answer nor an error on the
   * stream: is the answer in the server's store anyway? If so the events did
   * not arrive in the shape this turn reads — take the turn's result from the
   * store (the same parts, so the same translation) and report the drift, so
   * the next turn on this host uses `run` instead.
   */
  private async recover(): Promise<void> {
    const messages = await this.messages();
    const unanswered = !messages.some((m) => m.info?.role === "assistant" && m.info.parentID === this.userMessageId);
    // Unless the session is still busy (the prompt may yet run), a prompt with
    // no reply at all was dropped: an abort drops every prompt queued behind
    // the one it stops (verified on 1.18.32), and the turn — which leaves that
    // abort's error to the reply it ended — says so rather than claim a silent
    // success.
    if (unanswered && !(await this.isBusy().catch(() => true))) {
      this.turn.readLine(JSON.stringify({ type: "error", sessionID: this.sessionId, error: PROMPT_NOT_RUN }), this.onStream);
      return;
    }
    const lines = runLinesFromMessages(messages, this.sessionId, this.userMessageId);
    if (!lines.some(isAnswerLine) && !this.missedIdle) return;
    for (const line of lines) if (this.firstReport(line)) this.turn.readLine(line, this.onStream);
    this.deps.onProtocolDrift?.(
      this.missedIdle
        ? "the turn ended without the stream saying so"
        : "a finished turn's answer is in the server's store but never arrived on the event stream",
    );
  }

  private async createSession(): Promise<string> {
    const id = str(record(await this.post("/session", {}))?.id);
    if (!id) throw new Error("the server created a session without an id");
    return id;
  }

  private promptBody(found: CancelledRequests = { cancelled: [], stopped: [] }): Record<string, unknown> {
    const model = promptModel(this.opts.model);
    const agent = agentFromCliFlags(this.opts.cliFlags);
    const flags = this.opts.cliFlags ?? [];
    if (flags.length > (agent ? 2 : 0)) {
      logger.warn(`opencode server mode ignores cliFlags other than --agent: ${flags.join(" ")}`);
    }
    return {
      messageID: this.userMessageId,
      parts: [
        // Synthetic: the model reads it, opencode's TUI does not show it as typed.
        ...(found.cancelled.length
          ? [{ type: "text", text: cancelledRequestsNotice(found.cancelled), synthetic: true, metadata: JINN_NOTICE_METADATA }]
          : []),
        ...(found.stopped.length
          ? [{ type: "text", text: stoppedRequestsNotice(found.stopped), synthetic: true, metadata: JINN_STOPPED_NOTICE_METADATA }]
          : []),
        { type: "text", text: buildOpencodePrompt(this.opts), metadata: JINN_PROMPT_METADATA },
      ],
      ...(model ? { model } : {}),
      ...(agent ? { agent } : {}),
      // As under `opencode run`, which has no question tool (see the file header).
      tools: { question: false },
    };
  }

  // ── The stream ───────────────────────────────────────────────────────────

  private async readStream(body: ReadableStream<Uint8Array>, onConnected: () => void): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      const drained = drainSseEvents(buffer + decoder.decode(value, { stream: true }));
      buffer = drained.rest;
      for (const event of drained.events) {
        if (event.type === "server.connected") onConnected();
        else if (!this.settled) this.onEvent(event);
      }
    }
  }

  /** What this turn does with each kind of server event it has to act on. */
  private readonly handlers: Record<string, (props: Record<string, unknown>) => void> = {
    "message.updated": (props) => this.onMessage(record(props.info) ?? {}),
    "message.part.updated": (props) => this.onPart(props),
    "session.created": (props) => this.adoptChild(props),
    "session.updated": (props) => this.adoptChild(props),
    "session.status": (props) => {
      if (props.sessionID !== this.sessionId) return;
      const status = str(record(props.status)?.type);
      if (status && status !== "idle") this.sawBusy = true;
      // `opencode run` itself ends on this, not on session.idle.
      else if (status === "idle") this.onIdle();
    },
    "session.idle": (props) => {
      if (props.sessionID === this.sessionId) this.onIdle();
    },
    "session.error": (props) => {
      if (this.terminationReason) return; // our own abort
      // Only while this turn's reply is the one running (or before any reply):
      // an error in the operator's prompt is not this turn's.
      if (this.activeAssistant && !this.own.has(this.activeAssistant)) return;
      this.feed(runLineForEvent({ type: "session.error", properties: props }, this.sessionId));
    },
    "permission.asked": (props) => this.answerFor(props, "/permission", "/reply", { reply: "once" }),
    "question.asked": (props) => this.answerFor(props, "/question", "/reject", undefined),
  };

  /** The session went idle: the turn is over, once its prompt is on its way
   *  and the session has been busy. An idle before the prompt is sent ends
   *  someone else's busy period, not one this turn's prompt is part of. */
  private onIdle(): void {
    if (this.sawBusy && this.posting) this.finish();
  }

  private onEvent(event: ServerEvent): void {
    if (!this.sessionId) return;
    this.handlers[event.type]?.(record(event.properties) ?? {});
  }

  /** Learn whose an assistant message is, and release its waiting parts. */
  private onMessage(info: Record<string, unknown>): void {
    const id = str(info.id);
    if (!id || info.sessionID !== this.sessionId || info.role !== "assistant") return;
    if (id > this.activeAssistant) this.activeAssistant = id;
    if (!this.own.has(id) && !this.foreign.has(id)) this.classify(id, info.parentID === this.userMessageId);
    if (this.own.has(id) && replyIsDone(info)) this.finish();
  }

  private classify(messageId: string, mine: boolean): void {
    (mine ? this.own : this.foreign).add(messageId);
    const waiting = this.pendingParts.get(messageId) ?? [];
    this.pendingParts.delete(messageId);
    if (mine) for (const event of waiting) this.onPart(record(event.properties) ?? {});
  }

  /** A part of this session: the turn's own are translated, others dropped. */
  private onPart(props: Record<string, unknown>): void {
    const part = record(props.part);
    if (!part || part.sessionID !== this.sessionId) return;
    const messageId = str(part.messageID) ?? "";
    if (messageId === this.userMessageId || this.foreign.has(messageId)) return;
    if (!this.own.has(messageId)) {
      // Its message has not said whose it is yet; hold it until it does.
      const waiting = this.pendingParts.get(messageId) ?? [];
      if (waiting.length < 500) waiting.push({ type: "message.part.updated", properties: props });
      this.pendingParts.set(messageId, waiting);
      return;
    }
    this.feed(runLineForEvent({ type: "message.part.updated", properties: props }, this.sessionId));
  }

  private feed(line: string | undefined): void {
    if (!line || !this.firstReport(line)) return;
    if (isAnswerLine(line)) this.answered = true;
    this.turn.readLine(line, this.onStream);
  }

  /** A sub-session joins the turn when one of the turn's own replies spawned
   *  it: created while that reply was running, or under a sub-session already
   *  in. A subagent of the operator's prompt stays out. */
  private adoptChild(props: Record<string, unknown>): void {
    const info = record(props.info);
    const id = str(info?.id);
    const parent = str(info?.parentID);
    if (!id || !parent || this.children.has(id)) return;
    const spawnedByOurReply = parent === this.sessionId && this.own.has(this.activeAssistant);
    if (spawnedByOurReply || this.children.has(parent)) this.children.add(id);
  }

  /** Whether a permission prompt or question belongs to this turn. */
  private asksForThisTurn(props: Record<string, unknown>): boolean {
    const sessionId = str(props.sessionID) ?? "";
    if (this.children.has(sessionId)) return true;
    if (sessionId !== this.sessionId) return false;
    const messageId = str(record(props.tool)?.messageID) ?? this.activeAssistant;
    return this.own.has(messageId);
  }

  /** Answer a permission prompt or question — only this turn's own. */
  private answerFor(props: Record<string, unknown>, base: string, verb: string, body: unknown): void {
    const requestId = str(props.id);
    if (!requestId || !this.asksForThisTurn(props)) return;
    void this.answer(`${base}/${encodeURIComponent(requestId)}${verb}`, body);
  }

  /** False for a tool part already reported at this status. */
  private firstReport(line: string): boolean {
    const parsed = JSON.parse(line) as { type: string; part?: Record<string, unknown> };
    if (parsed.type !== "tool_use") return true;
    const key = `${str(parsed.part?.callID) ?? str(parsed.part?.id)}:${str(record(parsed.part?.state)?.status)}`;
    if (this.toolSeen.has(key)) return false;
    this.toolSeen.add(key);
    return true;
  }

  private async answer(route: string, body: unknown): Promise<void> {
    try {
      await this.post(route, body);
    } catch (err) {
      logger.warn(`opencode server turn could not answer ${route}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private finish(): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveDone();
  }

  private post(route: string, body: unknown): Promise<unknown> {
    return this.request("POST", route, body);
  }

  private async request(
    method: "GET" | "POST" | "PATCH",
    route: string,
    body: unknown,
    signal: AbortSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  ): Promise<unknown> {
    const res = await fetch(`${this.server.apiUrl}${route}`, {
      method,
      headers: {
        authorization: basicAuthHeader(this.server.password),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      throw new Error(`${method} ${route} answered ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    const text = await res.text();
    if (!text) return undefined;
    try { return JSON.parse(text); } catch { return text; }
  }
}
