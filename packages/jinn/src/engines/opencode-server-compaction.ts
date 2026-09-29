import type { CompactionStats, EngineResult, EngineRunOpts } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { basicAuthHeader, type OpencodeServer } from "./opencode-server.js";
import { agentFromCliFlags, promptModel } from "./opencode-server-turn.js";
import { contextTokensFromStep, type StepTokens } from "./opencode-protocol.js";

/**
 * A `/compact` turn on an opencode server: opencode's own compaction
 * (`POST /session/:id/summarize`), not a prompt. What the TUI's compact
 * command calls. Verified on 1.18.32:
 *
 *  - it answers `true` only once the summary is written (a couple of seconds on
 *    a short session), so the turn is simply that request;
 *  - it stores a user message with a `compaction` part and an assistant
 *    message with `summary: true` and `mode: "compaction"` answering it, and
 *    the next prompt sees the summary in place of everything before it;
 *  - with `auto: false` it does not carry on by itself afterwards. Jinn's
 *    self-compaction queues its own resume turn, which must be the next thing
 *    the model reads.
 *
 * One more step is Jinn's. An opencode session receives Jinn's system prompt
 * (persona, operating manual, session context) as text at the top of its FIRST
 * user message — not as a system prompt — so compaction summarizes it away
 * with everything else. Straight after the summary the turn re-seeds it as a
 * synthetic user message posted with `noReply` (stored, not answered, hidden
 * from the TUI). Its Jinn metadata marks it as Jinn's own, so a later turn's
 * cancelled-request walk steps over it instead of reporting it as a request
 * the operator abandoned.
 *
 * The prompt's text after `/compact` is not used: summarize takes no
 * instructions. Jinn's self-compaction delivers the handoff as its own turn.
 */

/** Metadata on the re-seeded system prompt (see the header). */
export const JINN_RESEED_METADATA = { jinn: "context-reseed" } as const;

/** Summarizing a long session is one model call over all of it. */
export const COMPACTION_TIMEOUT_MS = 15 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;

export const RESEED_PREAMBLE =
  "[Jinn] Your context was just compacted. These are the operating instructions and the session context "
  + "this session runs under; they still apply in full, and the summary above does not replace them.";

type StoredMessage = { info?: Record<string, unknown> };

const isAssistant = (m: StoredMessage): boolean => m.info?.role === "assistant";

/** The newest summary among `messages` (oldest first, as the server lists
 *  them), and the last ordinary reply before it that recorded its usage. */
function summaryAndReplaced(messages: StoredMessage[]): { summary?: StoredMessage; replaced?: StoredMessage } {
  const newestFirst = [...messages].reverse();
  const at = newestFirst.findIndex((m) => isAssistant(m) && m.info!.summary === true);
  if (at < 0) return {};
  const replaced = newestFirst.slice(at + 1).find((m) => isAssistant(m) && m.info!.summary !== true && m.info!.tokens);
  return { summary: newestFirst[at], replaced };
}

const tokensOf = (m: StoredMessage | undefined): number | undefined =>
  contextTokensFromStep(m?.info?.tokens as StepTokens | undefined);

/** See {@link OpencodeServerCompaction.summaryReport}. */
function summaryReport(messages: StoredMessage[]): { cost?: number; compaction: CompactionStats } {
  const { summary, replaced } = summaryAndReplaced(messages);
  const cost = summary?.info?.cost;
  const preTokens = tokensOf(replaced) ?? tokensOf(summary);
  return {
    ...(typeof cost === "number" && cost > 0 ? { cost } : {}),
    compaction: preTokens ? { preTokens } : {},
  };
}

export class OpencodeServerCompaction {
  private readonly controller = new AbortController();
  private terminationReason: string | null = null;
  private settled = false;
  /** The summarize request is out: an interrupt must stop it on the server too. */
  private posted = false;

  constructor(
    private readonly server: OpencodeServer,
    private readonly opts: EngineRunOpts,
  ) {}

  isSettled(): boolean {
    return this.settled;
  }

  /** Stop the compaction. Dropping the request does not stop the server's
   *  summarizing, so the session is aborted too. Idempotent. */
  async interrupt(reason: string): Promise<void> {
    if (this.terminationReason) return;
    this.terminationReason = reason;
    this.controller.abort();
    const sessionId = this.opts.resumeSessionId;
    if (!this.posted || !sessionId) return;
    await this.request("POST", `/session/${encodeURIComponent(sessionId)}/abort`, undefined)
      .catch((err) => logger.warn(`opencode compaction could not abort ${sessionId}: ${err instanceof Error ? err.message : String(err)}`));
  }

  async run(): Promise<EngineResult> {
    const sessionId = this.opts.resumeSessionId || "";
    try {
      return await this.compact(sessionId);
    } catch (err) {
      if (this.terminationReason) return { sessionId, result: "", error: this.terminationReason };
      return { sessionId, result: "", error: `opencode compaction failed: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
      this.settled = true;
    }
  }

  private async compact(sessionId: string): Promise<EngineResult> {
    // Nothing has run in this session yet, so there is nothing to compact.
    if (!sessionId) return { sessionId, result: "" };
    const route = `/session/${encodeURIComponent(sessionId)}`;
    const model = promptModel(this.opts.model) ?? await this.lastUserModel(route);
    if (!model) throw new Error("no model to summarize with: the turn names none and the session has no prior prompt");
    if (this.terminationReason) return { sessionId, result: "", error: this.terminationReason };

    this.posted = true;
    const done = await this.request("POST", `${route}/summarize`, { ...model, auto: false },
      AbortSignal.any([this.controller.signal, AbortSignal.timeout(COMPACTION_TIMEOUT_MS)]));
    if (done !== true) throw new Error(`summarize answered ${JSON.stringify(done)?.slice(0, 200)}`);
    logger.info(`opencode compaction summarized session ${sessionId} (${model.providerID}/${model.modelID})`);

    await this.reseed(route, model);
    const { cost, compaction } = await this.summaryReport(route);
    return { sessionId, result: "", numTurns: 1, compaction, ...(cost ? { cost } : {}) };
  }

  /** Put Jinn's system prompt back in front of the model (see the header).
   *  Best effort: a failure costs the persona until the session's next fresh
   *  start, not the compaction, and is logged loudly. */
  private async reseed(route: string, model: { providerID: string; modelID: string }): Promise<void> {
    if (!this.opts.systemPrompt) return;
    const agent = agentFromCliFlags(this.opts.cliFlags);
    try {
      await this.request("POST", `${route}/message`, {
        noReply: true,
        model,
        ...(agent ? { agent } : {}),
        parts: [{
          type: "text",
          text: `${RESEED_PREAMBLE}\n\n${this.opts.systemPrompt}`,
          synthetic: true,
          metadata: JINN_RESEED_METADATA,
        }],
      });
    } catch (err) {
      logger.error(`opencode compaction could not re-seed the system prompt into ${route}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The model the session's newest user message ran on. */
  private async lastUserModel(route: string): Promise<{ providerID: string; modelID: string } | undefined> {
    const messages = await this.messages(route, 20);
    for (const message of [...messages].reverse()) {
      const info = message.info;
      if (info?.role !== "user") continue;
      const model = info.model as { providerID?: unknown; modelID?: unknown } | undefined;
      if (typeof model?.providerID === "string" && typeof model.modelID === "string") {
        return { providerID: model.providerID, modelID: model.modelID };
      }
    }
    return undefined;
  }

  /**
   * What the summary cost, for the spend ledger, and the size of the context it
   * replaced. That size is the last ordinary reply's usage — what the context
   * meter showed — not the summarizing call's input, which counts only the
   * conversation (live, 1.18.32: 1.5k against a 21.9k context with the system
   * prompt and tools). The summary's input is the fallback. The size after is
   * not reported: the summary plus the re-seeded system prompt, which no one
   * message counts. Best effort: summarize already answered, so the compaction
   * happened either way.
   */
  private async summaryReport(route: string): Promise<{ cost?: number; compaction: CompactionStats }> {
    try {
      return summaryReport(await this.messages(route, 10));
    } catch {
      return { compaction: {} };
    }
  }

  private async messages(route: string, limit: number): Promise<StoredMessage[]> {
    const body = await this.request("GET", `${route}/message?limit=${limit}`, undefined);
    return Array.isArray(body) ? body as StoredMessage[] : [];
  }

  private async request(
    method: "GET" | "POST",
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
