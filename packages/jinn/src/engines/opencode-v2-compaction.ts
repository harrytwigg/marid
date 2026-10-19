import type { CompactionStats, EngineResult, EngineRunOpts } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import type { OpencodeServer } from "./opencode-server.js";
import { promptModel } from "./opencode-server-turn.js";
import { COMPACTION_TIMEOUT_MS } from "./opencode-server-compaction.js";
import { contextTokensFromStep, type StepTokens } from "./opencode-protocol.js";
import { record, str, type V2Message } from "./opencode-v2-events.js";
import { sessionRoute, v2Headers, v2Messages, v2Request, v2UpdateSessionNotes } from "./opencode-v2-api.js";
import { parseSseEvent } from "./opencode-v2-turn.js";

/**
 * A `/compact` turn on an OpenCode 2 server: opencode's own compaction, the
 * counterpart of `OpencodeServerCompaction` for 1.x. Verified on 2.0.29:
 *
 *  - `POST /api/session/:id/compact` queues a compaction item and answers at
 *    once; the session then runs it as an execution of its own, reporting
 *    `session.compaction.started`, then `session.compaction.ended` (with the
 *    summary) or `session.compaction.failed` (with the error), then
 *    `session.execution.succeeded` either way;
 *  - it summarizes with the session's model, so the turn's model is selected
 *    first, as a turn does;
 *  - it does not carry on by itself afterwards.
 *
 * The re-seed is the same as on 1.x (see that file's header), but sent with
 * the session's next prompt: the compaction notes on the session that it is
 * due, and the next turn puts the system prompt in front of its own
 * (opencode-v2-history.ts). An input queued now would get a model step of its own.
 */

/** Context the compaction item, the summary and the reply before them carry. */
function compactionReport(newestFirst: V2Message[], inputId: string): { cost?: number; compaction: CompactionStats } {
  const at = newestFirst.findIndex((m) => str(m.id) === inputId);
  const item = at >= 0 ? newestFirst[at] : undefined;
  const replaced = at >= 0 ? newestFirst.slice(at + 1).find((m) => m.type === "assistant" && m.tokens) : undefined;
  const preTokens = contextTokensFromStep(record(replaced?.tokens) as StepTokens | undefined)
    ?? contextTokensFromStep(record(item?.tokens) as StepTokens | undefined);
  const cost = item?.cost;
  return { ...(typeof cost === "number" && cost > 0 ? { cost } : {}), compaction: preTokens ? { preTokens } : {} };
}

export class OpencodeV2ServerCompaction {
  private readonly controller = new AbortController();
  private terminationReason: string | null = null;
  private settled = false;
  /** The compaction is queued: an interrupt must stop it on the server too. */
  private inputId?: string;

  constructor(
    private readonly server: OpencodeServer,
    private readonly opts: EngineRunOpts,
    private readonly abort: (target: { engineSessionId: string; userMessageId: string }) => Promise<void>,
  ) {}

  isSettled(): boolean {
    return this.settled;
  }

  async interrupt(reason: string): Promise<void> {
    if (this.terminationReason) return;
    this.terminationReason = reason;
    this.controller.abort();
    const sessionId = this.opts.resumeSessionId;
    if (!this.inputId || !sessionId) return;
    await this.abort({ engineSessionId: sessionId, userMessageId: this.inputId })
      .catch((err) => logger.warn(`opencode compaction could not stop ${sessionId}: ${err instanceof Error ? err.message : String(err)}`));
  }

  async run(): Promise<EngineResult> {
    const sessionId = this.opts.resumeSessionId || "";
    const kept = () => (this.inputId ? { numTurns: 1 } : {});
    try {
      return await this.compact(sessionId);
    } catch (err) {
      if (this.terminationReason) return { sessionId, result: "", error: this.terminationReason, ...kept() };
      return { sessionId, result: "", error: `opencode compaction failed: ${err instanceof Error ? err.message : String(err)}`, ...kept() };
    } finally {
      this.settled = true;
      this.controller.abort();
    }
  }

  private async compact(sessionId: string): Promise<EngineResult> {
    if (!sessionId) return { sessionId, result: "" };
    await this.selectModel(sessionId);
    if (this.terminationReason) return { sessionId, result: "", error: this.terminationReason };
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(COMPACTION_TIMEOUT_MS)]);
    const events = await this.subscribe(signal);
    const item = record(await v2Request(this.server, "POST", sessionRoute(sessionId, "/compact"), { delivery: "queue" }));
    this.inputId = str(item?.id);
    if (!this.inputId) throw new Error("the server queued the compaction without an id");
    await this.awaitOutcome(events, sessionId, this.inputId);
    logger.info(`opencode compaction summarized session ${sessionId}`);
    await this.reseed(sessionId);
    const report = await v2Messages(this.server, sessionId, 20).then((m) => compactionReport(m, this.inputId!)).catch(() => ({ compaction: {} }));
    return { sessionId, result: "", numTurns: 1, ...report };
  }

  /** Summarize with the turn's model, as 1.x does: 2.x uses the session's. */
  private async selectModel(sessionId: string): Promise<void> {
    const model = promptModel(this.opts.model);
    if (!model) return;
    const session = record(await v2Request(this.server, "GET", sessionRoute(sessionId)));
    const current = record(session?.model);
    if (current?.providerID === model.providerID && current?.id === model.modelID) return;
    await v2Request(this.server, "POST", sessionRoute(sessionId, "/model"), { model: { providerID: model.providerID, id: model.modelID } });
  }

  /** The event stream, open (connected) before the compaction is queued. */
  private async subscribe(signal: AbortSignal): Promise<AsyncGenerator<Record<string, unknown>>> {
    const res = await fetch(`${this.server.apiUrl}/api/event`, {
      headers: { ...v2Headers(this.server.password), accept: "text/event-stream" },
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`GET /api/event answered ${res.status}`);
    const events = readEvents(res.body);
    // Not `for await`: leaving that loop would close the stream.
    for (;;) {
      const next = await events.next();
      if (next.done) throw new Error("the event stream closed before it connected");
      if (next.value.type === "server.connected") return events;
    }
  }

  /** Wait for the compaction's own outcome; a failure is the turn's error.
   *  Only `compaction.started` names the queued item; its end follows it in
   *  the same session (2.0.29's `ended` carries no `inputID`). */
  private async awaitOutcome(events: AsyncGenerator<Record<string, unknown>>, sessionId: string, inputId: string): Promise<void> {
    let started = false;
    for await (const event of events) {
      const data = record(event.data) ?? {};
      if (data.sessionID !== sessionId) continue;
      if (event.type === "session.compaction.started") started = data.inputID === inputId;
      else if (started && compactionEnded(event.type, data)) return;
    }
    throw new Error("the event stream closed before the compaction finished");
  }

  /** Have the next turn put Jinn's system prompt back in front of the model.
   *  Best effort: a failure costs the persona until the session's next fresh
   *  start, not the compaction, and is logged loudly. */
  private async reseed(sessionId: string): Promise<void> {
    if (!this.opts.systemPrompt) return;
    try {
      await v2UpdateSessionNotes(this.server, sessionId, (notes) => ({ ...notes, reseed: true }));
    } catch (err) {
      logger.error(`opencode compaction could not note the system prompt re-seed on ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Whether a compaction event ends it: true when it succeeded; a failure throws. */
function compactionEnded(type: unknown, data: Record<string, unknown>): boolean {
  if (type === "session.compaction.failed") throw new Error(str(record(data.error)?.message) ?? "the compaction failed");
  return type === "session.compaction.ended";
}

async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let at: number;
    while ((at = buffer.indexOf("\n\n")) >= 0) {
      const event = parseSseEvent(buffer.slice(0, at));
      buffer = buffer.slice(at + 2);
      if (event) yield event as unknown as Record<string, unknown>;
    }
  }
}
