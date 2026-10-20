import type { EngineResult, EngineRunOpts, StreamDelta } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { USER_STOP_INTERRUPTION_REASON } from "../sessions/interruption-reasons.js";
import { OpencodeTurn } from "./opencode-turn.js";
import { buildOpencodePrompt } from "./opencode-protocol.js";
import type { OpencodeServer } from "./opencode-server.js";
import {
  agentFromCliFlags,
  cancelledRequestsNotice,
  newMessageId,
  noAnswerReason,
  promptModel,
  SERVER_TURN_TIMING,
  stoppedRequestsNotice,
  type ServerTurnDeps,
} from "./opencode-server-turn.js";
import { fallbackModelNotice, requestedModel, stepModel } from "./opencode-fallback-notice.js";
import { abandonedRetryError, providerFailureReason, SettleWait, type ProviderRetry, type SettleKind } from "./opencode-server-settle.js";
import { isAbortError, record, runLinesFromStoredReply, str, V2RunLines, v2ReplyIsDone, type V2Event, type V2Message } from "./opencode-v2-events.js";
import { cancelledV2Requests, JINN_V2_PROMPT_METADATA, jinnSessionNotes, type JinnSessionNotes } from "./opencode-v2-history.js";
import { sessionRoute, v2Headers, v2InInbox, v2Messages, v2Request, v2RunningSessions, v2UpdateSessionNotes } from "./opencode-v2-api.js";
import { RESEED_PREAMBLE } from "./opencode-server-compaction.js";
import { sameModelRef, unsupportedServerFlags, variantOf, type V2ModelRef } from "./opencode-variant.js";

/**
 * One Jinn turn on an OpenCode 2 server (`/api/*`), the counterpart of
 * `OpencodeServerTurn` for 1.x. The steps are the same:
 *
 *   1. subscribe to `/api/event` and wait for `server.connected`;
 *   2. create the opencode session, or resume the one named (switching its
 *      model first when the turn names another: 2.x keeps the model on the
 *      session, not on each prompt);
 *   3. post the prompt (`/prompt`, delivery `queue`) under an id the turn made;
 *   4. translate the stream (opencode-v2-events.ts) into the lines
 *      `OpencodeTurn` reads, until the turn's reply is done or the session's
 *      execution ends.
 *
 * What 2.x makes simpler: the server says which input each step answers
 * (`session.inbox.delivered` names the input, every step event names its
 * assistant message), and an execution ends with an explicit outcome
 * (`session.execution.succeeded|failed|interrupted`). A prompt posted with
 * delivery `queue` while the operator's own prompt runs waits for it, and is
 * then delivered into the same execution, so the steps after its delivery are
 * the turn's and the ones before are not.
 *
 * Approval matches 1.x: a permission this turn's steps ask for is granted
 * once; the `question` tool is denied on the sessions the turn creates (which
 * takes it out of the tool list), and a question that still comes is
 * dismissed.
 */

/** The turn's error when its execution ended without ever delivering the prompt. */
const PROMPT_NOT_RUN = {
  name: "PromptNotRun",
  data: { message: "opencode ended the session's execution without running this turn's prompt" },
};
const TURN_TIMEOUT_MS = 14 * 24 * 60 * 60 * 1000;
const HISTORY_LIMIT = 100;
const QUOTE_LIMIT = 500;
/** Deny the question tool: nobody is there to answer it (see the header). */
const NO_QUESTIONS = [{ action: "question", resource: "*", effect: "deny" }];

function answerKind(line: string): "text" | "error" | undefined {
  return /^\{"type":"(text|error)"/.exec(line)?.[1] as "text" | "error" | undefined;
}

/** What makes a line a repeat: a tool at the same status, or a text with the
 *  same text. A store re-read never reports either twice. */
function reportKey(line: string): string | undefined {
  const parsed = JSON.parse(line) as { type: string; part?: Record<string, unknown> };
  const part = parsed.part;
  if (parsed.type === "tool_use") return `tool:${str(part?.callID)}:${str(record(part?.state)?.status)}`;
  if (parsed.type === "text") return `text:${str(part?.id)}:${str(part?.text)}`;
  return undefined;
}

/** The replies (assistant items) answering `prompt`, oldest first, from a
 *  history listed newest first: what follows the prompt up to the next input
 *  someone else sent. */
export function ownStoredReplies(newestFirst: V2Message[], prompt: string): V2Message[] {
  const replies: V2Message[] = [];
  let ours = false;
  for (const message of [...newestFirst].reverse()) {
    const id = str(message.id) ?? "";
    if (id === prompt) ours = true;
    else if (message.type === "user" || message.type === "compaction") ours = false;
    else if (ours && message.type === "assistant") replies.push(message);
  }
  return replies;
}

export class OpencodeV2ServerTurn {
  private readonly turn: OpencodeTurn;
  private readonly controller = new AbortController();
  private sessionId = "";
  private lines = new V2RunLines("");
  /** The id the turn's prompt is posted under. */
  private readonly promptId = newMessageId();
  private promptText = "";
  /** The model the turn's steps ran on, when a host plugin moved them off the one asked for. */
  private ranOn?: string;
  /** What the session's metadata held for this turn to say (see opencode-v2-history.ts). */
  private notes: JinnSessionNotes = { stopped: [], reseed: false };
  /** The input the session runs now is the turn's prompt. */
  private ownInput = false;
  /** Inputs someone else queued (delivery `queue`) after the turn subscribed:
   *  the ones whose delivery ends the turn's input (see onDelivered). */
  private readonly queuedByOthers = new Set<string>();
  /** The turn's prompt has been delivered. */
  private delivered = false;
  /** Assistant messages (one per step) answering the turn. */
  private readonly own = new Set<string>();
  /** The newest step in the session, whoever's. */
  private activeAssistant = "";
  private newestOwnOpen = false;
  /** The turn's newest step as far as the stream or the store said. */
  private ownReply?: Record<string, unknown>;
  private readonly settle = new SettleWait((kind) => this.onSettled(kind));
  private providerRetry?: ProviderRetry;
  private abandonedRetry?: ProviderRetry;
  private lastAnswer?: "text" | "error";
  /** Sub-sessions the turn's steps spawned (a subagent's), transitively. */
  private readonly children = new Set<string>();
  private terminationReason: string | null = null;
  private failure: string | null = null;
  private settled = false;
  private resolveDone!: () => void;
  private readonly done = new Promise<void>((resolve) => { this.resolveDone = resolve; });
  private readonly seen = new Set<string>();
  private interrupting?: Promise<void>;
  private posting?: Promise<unknown>;
  private posted = false;
  /** The server's event stream answered `server.connected`. */
  private streamConnected = false;
  private answered = false;
  private streamErred = false;
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

  /** Stop the turn: on the server first, then here. Idempotent. */
  interrupt(reason: string): Promise<void> {
    if (this.interrupting) return this.interrupting;
    this.terminationReason = reason;
    this.interrupting = this.stopOnServer()
      .then(() => (reason === USER_STOP_INTERRUPTION_REASON ? this.noteStoppedByUser() : undefined))
      .finally(() => this.finish());
    return this.interrupting;
  }

  isSettled(): boolean {
    return this.settled;
  }

  /**
   * The turn failed before the server had spoken to it: its event stream never
   * connected (nothing was posted, so nothing ran). The server is not usable
   * for this session, and the turn can run elsewhere unchanged.
   */
  get serverUnreachable(): boolean {
    return !this.streamConnected && !this.posted && !this.terminationReason && this.failure !== null;
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
      this.settle.cancel();
      this.controller.abort();
    }
    const result = this.failedTurn(this.turn.result({
      code: this.failure ? 1 : 0,
      terminationReason: this.terminationReason,
      stderr: this.failure ?? "",
      failure: this.failure ?? undefined,
      noAnswer: this.noAnswer(),
    }));
    return this.ranOn ? { ...result, notices: [fallbackModelNotice(this.ranOn)] } : result;
  }

  /** As 1.x: a usage window says when it ends, and a prompt the server took
   *  means the conversation exists whatever happened next. */
  private failedTurn(result: EngineResult): EngineResult {
    if (!result.error) return result;
    const next = this.abandonedRetry?.next;
    if (next) return { ...result, numTurns: result.numTurns || 1, rateLimit: { status: "rejected", resetsAt: Math.ceil(next / 1000) } };
    if (this.posted && !result.numTurns) return { ...result, numTurns: 1 };
    return result;
  }

  private noAnswer(): string {
    const reason = noAnswerReason(this.ownReply);
    return this.providerRetry ? providerFailureReason(this.providerRetry, reason) : reason;
  }

  private async drive(): Promise<void> {
    await this.openStream();
    if (!this.settled) await this.start();
    await this.done;
    if (this.interrupting) await this.interrupting;
    if (this.statusPoll) clearInterval(this.statusPoll);
    await this.afterTurn();
  }

  private async afterTurn(): Promise<void> {
    if (this.terminationReason) return;
    if (this.failure || this.abandonedRetry) await this.stopOnServer();
    if (!this.failure && this.needsStore()) await this.recover();
  }

  private needsStore(): boolean {
    return !this.answered || this.missedIdle || (this.newestOwnOpen && !this.streamErred);
  }

  private async fail(err: unknown): Promise<void> {
    if (!this.terminationReason) {
      this.failure = `opencode server turn failed: ${err instanceof Error ? err.message : String(err)}`;
      await this.stopOnServer();
    }
    this.finish();
  }

  private async stopOnServer(): Promise<void> {
    if (this.posting) await this.posting.catch(() => undefined);
    if (!this.posted) return;
    await this.deps.abort({ engineSessionId: this.sessionId, userMessageId: this.promptId }).catch(() => undefined);
  }

  /**
   * The user stopped the turn: note it on the session, for the next Jinn turn
   * to tell the model (2.x cannot mark the delivered prompt itself). It survives
   * a gateway restart, and `run()` does not return until it is written. Best
   * effort: without it the next turn is simply not told.
   */
  private async noteStoppedByUser(): Promise<void> {
    if (!this.delivered) return;
    const request = this.opts.prompt.slice(0, QUOTE_LIMIT + 1).trim() || "(a request with no text)";
    try {
      await v2UpdateSessionNotes(this.server, this.sessionId, (notes) => ({ ...notes, stopped: [...notes.stopped, request] }));
    } catch (err) {
      logger.warn(`opencode server turn could not record its stopped prompt in ${this.sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Steps ────────────────────────────────────────────────────────────────

  private openStream(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the event stream did not connect")), SERVER_TURN_TIMING.connectMs);
      timer.unref?.();
      void (async () => {
        const res = await fetch(`${this.server.apiUrl}/api/event`, {
          headers: { ...v2Headers(this.server.password), accept: "text/event-stream" },
          signal: this.controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`GET /api/event answered ${res.status}`);
        await this.readStream(res.body, () => {
          this.streamConnected = true;
          clearTimeout(timer);
          resolve();
        });
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
    this.sessionId = this.opts.resumeSessionId
      ? await this.resumeSession(this.opts.resumeSessionId)
      : await this.createSession();
    this.lines = new V2RunLines(this.sessionId);
    this.turn.readLine(JSON.stringify({ type: "session", sessionID: this.sessionId }), null);
    this.deps.onSessionId?.(this.sessionId);
    if (this.terminationReason) return;
    const cancelled = this.opts.resumeSessionId ? await this.readHistory() : [];
    if (this.terminationReason) return;
    this.posting = this.postPrompt(cancelled);
    await this.posting;
    this.posted = true;
    this.armStatusPoll();
  }

  /** The turn's model as the 2.x API takes it, with the effort level as the
   *  ref's `variant`: the session keeps the variant with the model. */
  private modelRef(): V2ModelRef | undefined {
    const model = promptModel(this.opts.model);
    if (!model) return undefined;
    const variant = variantOf(this.opts);
    return { providerID: model.providerID, id: model.modelID, ...(variant ? { variant } : {}) };
  }

  private async createSession(): Promise<string> {
    const model = this.modelRef();
    const agent = agentFromCliFlags(this.opts.cliFlags);
    const created = record(await v2Request(this.server, "POST", "/api/session", {
      ...(model ? { model } : {}),
      ...(agent ? { agent } : {}),
      permissions: NO_QUESTIONS,
    }));
    const id = str(created?.id);
    if (!id) throw new Error("the server created a session without an id");
    return id;
  }

  /** The session to resume, on the turn's model, variant and agent. A session the
   *  server does not know fails here, as a 1.x post to one does. */
  private async resumeSession(id: string): Promise<string> {
    const session = record(await v2Request(this.server, "GET", sessionRoute(id))) ?? {};
    this.notes = jinnSessionNotes(record(session.metadata));
    const model = this.modelRef();
    // The model is selected again when the variant alone changed too, going
    // from a variant to none included.
    if (model && !sameModelRef(record(session.model), model)) {
      await v2Request(this.server, "POST", sessionRoute(id, "/model"), { model });
    }
    const agent = agentFromCliFlags(this.opts.cliFlags);
    if (agent && session.agent !== agent) await v2Request(this.server, "POST", sessionRoute(id, "/agent"), { agent });
    return id;
  }

  /** Requests the operator cancelled since the session last ran (see
   *  opencode-v2-history.ts). Best effort: an unreadable history costs the
   *  notice, not the turn. */
  private async readHistory(): Promise<string[]> {
    try {
      const [history, running] = await Promise.all([
        v2Messages(this.server, this.sessionId, HISTORY_LIMIT),
        v2RunningSessions(this.server),
      ]);
      const found = cancelledV2Requests(history, running.includes(this.sessionId));
      if (found.length) logger.info(`opencode server turn tells the model ${found.length} request(s) were cancelled in ${this.sessionId}`);
      return found;
    } catch (err) {
      logger.warn(`opencode server turn could not read session ${this.sessionId}'s history: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  private async postPrompt(cancelled: string[]): Promise<void> {
    const ignored = unsupportedServerFlags(this.opts.cliFlags);
    if (ignored.length) {
      logger.warn(`opencode server mode ignores cliFlags other than --agent and --variant: ${ignored.join(" ")}`);
    }
    const notices = this.notices(cancelled);
    this.promptText = [...notices, buildOpencodePrompt(this.opts)].join("\n\n---\n\n");
    await v2Request(this.server, "POST", sessionRoute(this.sessionId, "/prompt"), {
      id: this.promptId,
      text: this.promptText,
      metadata: { ...JINN_V2_PROMPT_METADATA, ...(notices.length ? { notice: true } : {}) },
      delivery: "queue",
    });
    await this.clearNotes(notices.length > 0);
  }

  /** What goes in front of the prompt: the system prompt again after a
   *  compaction, then the requests the operator cancelled and the user stopped. */
  private notices(cancelled: string[]): string[] {
    return [
      ...(this.notes.reseed && this.opts.systemPrompt ? [`${RESEED_PREAMBLE}\n\n${this.opts.systemPrompt}`] : []),
      ...(cancelled.length ? [cancelledRequestsNotice(cancelled)] : []),
      ...(this.notes.stopped.length ? [stoppedRequestsNotice(this.notes.stopped)] : []),
    ];
  }

  /** The notes this prompt carried are said now: clear those, and only those
   *  (a re-seed a turn without a system prompt could not send stays due, as
   *  does a stop noted since the turn read them). Best effort: kept, a note is
   *  said again. */
  private async clearNotes(sentAny: boolean): Promise<void> {
    const sent = { stopped: this.notes.stopped, reseed: this.notes.reseed && Boolean(this.opts.systemPrompt) };
    if (!sentAny || (!sent.stopped.length && !sent.reseed)) return;
    try {
      await v2UpdateSessionNotes(this.server, this.sessionId, (notes) => ({
        stopped: notes.stopped.filter((request) => !sent.stopped.includes(request)),
        reseed: notes.reseed && !sent.reseed,
      }));
    } catch (err) {
      logger.warn(`opencode server turn could not clear its notes on ${this.sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Backstop for an execution end the stream never announced. */
  private armStatusPoll(): void {
    let idleAnswers = 0;
    this.statusPoll = setInterval(() => {
      void (async () => {
        const running = await v2RunningSessions(this.server);
        idleAnswers = running.includes(this.sessionId) ? 0 : idleAnswers + 1;
        if (idleAnswers >= 2 && !this.settled) {
          this.missedIdle = true;
          this.finish();
        }
      })().catch(() => { /* the stream's own failure handling covers a dead server */ });
    }, SERVER_TURN_TIMING.statusPollMs);
    this.statusPoll.unref?.();
  }

  /** The stream did not say how the turn ended: read its replies from the store. */
  private async recover(): Promise<void> {
    const history = await v2Messages(this.server, this.sessionId, HISTORY_LIMIT);
    const replies = ownStoredReplies(history, this.promptId);
    if (replies.length) this.ownReply = replies.at(-1);
    if (!replies.length && !(await this.mayStillRun())) {
      this.turn.readLine(JSON.stringify({ type: "error", sessionID: this.sessionId, error: PROMPT_NOT_RUN }), this.onStream);
      // Still in the inbox: it must not run unattended beside the next turn.
      await this.stopOnServer();
      return;
    }
    const lines = replies.flatMap((reply) => runLinesFromStoredReply(this.sessionId, reply));
    const answer = lines.some((line) => answerKind(line) !== undefined);
    if (!answer && !this.missedIdle && !(replies.length && this.replyLeftOpen())) return;
    for (const line of lines) if (this.firstReport(line)) this.turn.readLine(line, this.onStream);
    await this.settleRecovered(answer);
  }

  /** The session is still running, with the prompt delivered or about to be. */
  private async mayStillRun(): Promise<boolean> {
    try {
      const running = (await v2RunningSessions(this.server)).includes(this.sessionId);
      return running && !(await v2InInbox(this.server, this.sessionId, this.promptId));
    } catch {
      return true;
    }
  }

  private replyLeftOpen(): boolean {
    const reply = this.ownReply;
    return Boolean(reply) && !record(reply!.time)?.completed && !reply!.error;
  }

  /** As 1.x: a reply that never ended is a dropped turn; an answer the stream
   *  missed from a reply that finished is drift. */
  private async settleRecovered(answer: boolean): Promise<void> {
    const reply = this.ownReply;
    if (!reply || (!v2ReplyIsDone(reply) && !reply.error)) {
      this.failure = "the opencode server stopped running the turn before its reply finished";
      await this.stopOnServer();
      return;
    }
    const streamMissedIt = !this.answered || this.missedIdle;
    if (!answer || !streamMissedIt || !v2ReplyIsDone(reply)) return;
    this.deps.onProtocolDrift?.(
      this.missedIdle
        ? "the turn ended without the stream saying so"
        : "a finished turn's answer is in the server's store but never arrived on the event stream",
    );
  }

  // ── The stream ───────────────────────────────────────────────────────────

  private async readStream(body: ReadableStream<Uint8Array>, onConnected: () => void): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let at: number;
      while ((at = buffer.indexOf("\n\n")) >= 0) {
        const event = parseSseEvent(buffer.slice(0, at));
        buffer = buffer.slice(at + 2);
        if (!event) continue;
        if (event.type === "server.connected") onConnected();
        else if (!this.settled && this.sessionId) this.onEvent(event);
      }
    }
  }

  private readonly handlers: Record<string, (data: Record<string, unknown>, event: V2Event) => void> = {
    "session.inbox.enqueued": (data) => this.onEnqueued(data),
    "session.inbox.delivered": (data) => this.onDelivered(data),
    "session.inbox.delivery.changed": (data) => this.onDeliveryChanged(data),
    "session.step.started": (data) => this.onStepStarted(data),
    "session.step.ended": (data, event) => this.onStepEnded(data, event),
    "session.step.failed": (data, event) => this.onStepFailed(data, event),
    "session.retry.scheduled": (data) => this.onRetry(data),
    "session.execution.succeeded": () => this.onExecutionEnded(),
    "session.execution.interrupted": () => this.onExecutionEnded(),
    "session.execution.failed": (_data, event) => {
      if (this.runsOwnReply() && !this.terminationReason) this.feed(this.lines.lineFor(event));
      this.onExecutionEnded();
    },
    "session.created": (data) => this.adoptChild(data),
    "permission.asked": (data) => this.answerPermission(data),
    "form.created": (data) => this.dismissForm(record(data.form) ?? {}),
  };

  private onEvent(event: V2Event): void {
    const data = record(event.data) ?? {};
    const handler = this.handlers[event.type];
    if (handler) {
      // Child sessions only matter for the permission and form prompts.
      if (data.sessionID === this.sessionId || event.type === "permission.asked" || event.type === "form.created" || event.type === "session.created") {
        handler(data, event);
      }
      return;
    }
    // Text and tool events: the turn's own steps only.
    if (data.sessionID === this.sessionId && this.own.has(str(data.assistantMessageID) ?? "")) this.feed(this.lines.lineFor(event));
  }

  /** Note which inputs others queue (see onDelivered). */
  private onEnqueued(data: Record<string, unknown>): void {
    const id = str(data.inboxID);
    if (id && id !== this.promptId && record(data.item)?.delivery === "queue") this.queuedByOthers.add(id);
  }

  /** An input waiting in the inbox was switched between steer and queue (the
   *  2.x terminal's per-item toggle): it is taken by its delivery now. */
  private onDeliveryChanged(data: Record<string, unknown>): void {
    const id = str(data.inboxID);
    if (!id || id === this.promptId) return;
    if (data.delivery === "queue") this.queuedByOthers.add(id);
    else this.queuedByOthers.delete(id);
  }

  /**
   * The session took up an input: the steps after it answer that input. Two
   * deliveries do not move the session off the turn's input while it runs:
   *
   * - one steered in (`delivery: steer`, what a terminal or a client sending
   *   no delivery uses): 2.x adds it to the running input at the next step,
   *   and the model answers both there (verified on 2.0.29: a steer during a
   *   tool call, then one reply after it, in the same execution);
   * - one the turn never saw queued: anything queued before the turn's prompt
   *   is delivered before it, so a foreign input delivered after it can only
   *   have been steered.
   *
   * Only an input someone else queued after the turn's own ends it: that runs
   * once the turn's reply is done.
   */
  private onDelivered(data: Record<string, unknown>): void {
    const id = str(data.inboxID) ?? "";
    if (id === this.promptId) {
      this.ownInput = true;
      this.delivered = true;
      return;
    }
    if (this.ownInput && !this.queuedByOthers.has(id)) {
      logger.info(`opencode server turn in ${this.sessionId} continues with an input steered into it (${id})`);
      return;
    }
    this.ownInput = false;
  }

  private onStepStarted(data: Record<string, unknown>): void {
    const id = str(data.assistantMessageID);
    if (!id) return;
    this.activeAssistant = id;
    if (!this.ownInput) return;
    // A new attempt after a far-off retry, or the next step: the turn goes on.
    this.settle.cancel("retry");
    if (!this.own.has(id)) this.settle.cancel();
    this.own.add(id);
    this.newestOwnOpen = true;
    this.ownReply = { id };
    this.noteModel(data);
  }

  /** A step that ran on another model than the turn asked for, on a host whose opencode has a
   *  fallback plugin: the plugin switched it. Not a chain hop; the turn says so instead. */
  private noteModel(data: Record<string, unknown>): void {
    const ran = stepModel(data);
    const asked = requestedModel(this.modelRef());
    if (!ran || !asked || ran === asked || !this.deps.fallbackPluginOnHost?.()) return;
    if (!this.ranOn) {
      logger.warn(`opencode turn in ${this.sessionId} ran on ${ran}, not the requested ${asked}: the host's opencode fallback plugin switched models, not the gateway's chain (run \`jinn doctor\`)`);
    }
    this.ranOn = ran;
  }

  private onStepEnded(data: Record<string, unknown>, event: V2Event): void {
    const id = str(data.assistantMessageID) ?? "";
    if (!this.own.has(id)) return;
    this.feed(this.lines.lineFor(event));
    this.newestOwnOpen = false;
    this.ownReply = { id, finish: data.finish, tokens: data.tokens, cost: data.cost, time: { completed: Date.now() } };
    if (v2ReplyIsDone(this.ownReply)) this.onReplyEnded();
  }

  private onStepFailed(data: Record<string, unknown>, event: V2Event): void {
    const id = str(data.assistantMessageID) ?? "";
    if (!this.own.has(id)) return;
    const error = record(data.error);
    this.newestOwnOpen = false;
    this.ownReply = { id, finish: "error", error, time: { completed: Date.now() } };
    if (!this.terminationReason && !isAbortError(error)) this.feed(this.lines.lineFor(event));
    this.onReplyEnded();
  }

  /** opencode will retry the turn's step: keep the turn open, and name the
   *  provider's error; one due too far off ends the turn with it unless
   *  something moves first. */
  private onRetry(data: Record<string, unknown>): void {
    if (!this.runsOwnReply()) return;
    const error = record(data.error);
    this.providerRetry = {
      message: str(error?.message) ?? "the provider failed and opencode is retrying it",
      ...(typeof data.at === "number" ? { next: data.at } : {}),
    };
    this.settle.cancel("idle", "done");
    const next = this.providerRetry.next;
    if (next && next - Date.now() > SERVER_TURN_TIMING.retryWaitCapMs) this.settle.arm("retry", SERVER_TURN_TIMING.retryGraceMs);
  }

  /** The session's execution ended: the turn is over once its prompt is out.
   *  Without a text answer it waits a moment, as 1.x does after an idle. */
  private onExecutionEnded(): void {
    if (!this.posting) return;
    this.ownInput = false;
    if (this.lastAnswer === "text" && !this.newestOwnOpen) return this.finish();
    this.settle.arm("idle", SERVER_TURN_TIMING.closeWaitMs);
  }

  private onReplyEnded(): void {
    if (this.lastAnswer === "text") return this.finish();
    if (this.settle.pending !== "idle") this.settle.arm("done", SERVER_TURN_TIMING.closeWaitMs);
  }

  /** The session is running the turn's input: a session-wide event (a
   *  retry, a failed execution) is the turn's. Not before its prompt is
   *  delivered, when the session may be running someone else's. */
  private runsOwnReply(): boolean {
    return this.ownInput || this.own.has(this.activeAssistant);
  }

  private onSettled(kind: SettleKind): void {
    if (this.settled) return;
    if (kind === "retry" && this.providerRetry) {
      this.abandonedRetry = this.providerRetry;
      this.feed(JSON.stringify({ type: "error", sessionID: this.sessionId, error: abandonedRetryError(this.providerRetry) }));
    }
    this.finish();
  }

  /** A sub-session joins the turn when one of the turn's steps spawned it. */
  private adoptChild(data: Record<string, unknown>): void {
    const id = str(data.sessionID);
    const parent = str(data.parentID);
    if (!id || !parent || this.children.has(id)) return;
    if ((parent === this.sessionId && this.own.has(this.activeAssistant)) || this.children.has(parent)) this.children.add(id);
  }

  /** Whether a prompt from `sessionId`, raised by the step `messageId`, is this turn's. */
  private asksForThisTurn(sessionId: string, messageId: string | undefined): boolean {
    if (this.children.has(sessionId)) return true;
    return sessionId === this.sessionId && this.own.has(messageId ?? this.activeAssistant);
  }

  private answerPermission(data: Record<string, unknown>): void {
    const id = str(data.id);
    const sessionId = str(data.sessionID) ?? "";
    if (!id || !this.asksForThisTurn(sessionId, str(record(data.source)?.messageID))) return;
    void this.call("POST", sessionRoute(sessionId, `/permission/${encodeURIComponent(id)}/reply`), { decision: "once" });
  }

  private dismissForm(form: Record<string, unknown>): void {
    const id = str(form.id);
    const sessionId = str(form.sessionID) ?? "";
    const messageId = str(record(record(form.metadata)?.tool)?.messageID);
    if (!id || !this.asksForThisTurn(sessionId, messageId)) return;
    void this.call("DELETE", sessionRoute(sessionId, `/form/${encodeURIComponent(id)}`));
  }

  private async call(method: "POST" | "DELETE", route: string, body?: unknown): Promise<void> {
    try {
      await v2Request(this.server, method, route, body);
    } catch (err) {
      logger.warn(`opencode server turn could not answer ${route}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private feed(line: string | undefined): void {
    if (!line || !this.firstReport(line)) return;
    const kind = answerKind(line);
    if (kind) {
      this.answered = true;
      this.lastAnswer = kind;
    }
    if (kind === "error") this.streamErred = true;
    else {
      this.providerRetry = undefined;
      this.settle.cancel("retry");
    }
    this.turn.readLine(line, this.onStream);
  }

  private firstReport(line: string): boolean {
    const key = reportKey(line);
    if (key === undefined) return true;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }

  private finish(): void {
    if (this.settled) return;
    this.settled = true;
    this.settle.cancel();
    this.resolveDone();
  }
}

/** One SSE block as an event; heartbeats (comments) and junk are undefined. */
export function parseSseEvent(block: string): V2Event | undefined {
  const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
  if (!data) return undefined;
  try {
    const event = record(JSON.parse(data));
    return event && typeof event.type === "string" ? event as unknown as V2Event : undefined;
  } catch {
    logger.debug(`[opencode v2 server] unparseable event: ${data.slice(0, 100)}`);
    return undefined;
  }
}
