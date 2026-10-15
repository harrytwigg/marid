import type { EngineResult, StreamDelta } from "../shared/types.js";
import { MUSECODE_AUTH_HELP } from "./musecode-protocol.js";
import {
  asRecord,
  describeModelRetry,
  addTokenUsage,
  museTurnCost,
  num,
  parseTokenUsage,
  parseUsageChanged,
  parseTurnError,
  str,
  toolResultDelta,
  toolUseDelta,
  type MuseModelCost,
  type MuseUsageSnapshot,
  type MuseTurnError,
  type TokenUsage,
  type ToolItem,
} from "./musecode-turn-text.js";

export type { MuseModelCost, MuseUsageSnapshot } from "./musecode-turn-text.js";

/**
 * One Muse Code turn, accumulated from its MSP notifications.
 *
 * Separate from the engine because it is the half that can be tested without a
 * process: feed it the notifications a host sends and ask what the turn became.
 * The engine owns the host process and the requests; this owns what the turn
 * MEANS, and the two meet at `read` and `result`.
 *
 * Settling is only ever on `turn/completed`. `turn/foregroundCompleted` is
 * explicitly non-terminal: named background reminder checks may still be
 * running, and the turn is not over until they are.
 */

export type MuseTerminal = "completed" | "failed" | "cancelled" | (string & {});

export interface MuseTurnCallbacks {
  onStream?: ((delta: StreamDelta) => void) | null;
  /** Told of each `usage/changed` snapshot, so the latest can be kept. */
  onUsage?: (usage: MuseUsageSnapshot) => void;
}

interface MessageItem {
  phase: string | undefined;
  text: string;
  streamed: boolean;
}

export class MuseTurn {
  private readonly messages = new Map<string, MessageItem>();
  private readonly messageOrder: string[] = [];
  private readonly tools = new Map<string, ToolItem>();
  private streamedText = false;
  private turnId: string | undefined;
  private terminal: MuseTerminal | undefined;
  private error: MuseTurnError | undefined;
  private reason: string | undefined;
  /** The turn's own aggregate, when `turn/completed` carries one. */
  private usage: TokenUsage | undefined;
  /** The model calls' `session/tokenUsage` summed: what the real host reports when `turn/completed` has none. */
  private legs: TokenUsage | undefined;
  private durationMs: number | undefined;
  private contextUsed: number | undefined;
  private latestUsage: MuseUsageSnapshot | undefined;
  private unqueued = false;
  private completedWaiters: Array<() => void> = [];

  constructor(
    private readonly sessionId: string,
    private readonly callbacks: MuseTurnCallbacks = {},
  ) {}

  /** Named by `turn/start`'s answer; a `turn/completed` for any other turn of the session is not this one's. */
  setTurnId(turnId: string): void {
    this.turnId = turnId;
  }

  get isCompleted(): boolean {
    return this.terminal !== undefined || this.unqueued;
  }

  /** The latest subscription usage the host reported during the turn. */
  get subscriptionUsage(): MuseUsageSnapshot | undefined {
    return this.latestUsage;
  }

  /** Resolves when the turn has ended (`turn/completed`, or `turn/unqueued`). */
  whenCompleted(): Promise<void> {
    if (this.isCompleted) return Promise.resolve();
    return new Promise((resolve) => this.completedWaiters.push(resolve));
  }

  /** One notification of the connection. Other sessions' (a reminder child's, say) are ignored. */
  read(method: string, params: Record<string, unknown>): void {
    // The account's usage is not any one session's.
    if (method === "usage/changed") return this.readUsageChanged(params);
    if (str(params.sessionId) !== this.sessionId) return;
    this.sessionNotification(method, params);
  }

  private readonly sessionHandlers: Record<string, (params: Record<string, unknown>) => void> = {
    "item/started": (p) => this.readItem(asRecord(p.item), "open"),
    "item/updated": (p) => this.readItem(asRecord(p.item), "open"),
    "item/completed": (p) => this.readItem(asRecord(p.item), "done"),
    "item/delta": (p) => this.readDelta(p),
    "turn/modelRetryScheduled": (p) => this.callbacks.onStream?.({ type: "status", content: describeModelRetry(p) }),
    "session/contextUsage": (p) => {
      this.contextUsed = num(p.usedTokens) ?? this.contextUsed;
    },
    "session/tokenUsage": (p) => this.addLeg(p),
    "turn/completed": (p) => this.readCompleted(p),
    "turn/unqueued": () => {
      this.unqueued = true;
      this.wake();
    },
  };

  private sessionNotification(method: string, params: Record<string, unknown>): void {
    this.sessionHandlers[method]?.(params);
  }

  private wake(): void {
    for (const resolve of this.completedWaiters.splice(0)) resolve();
  }

  private readUsageChanged(params: Record<string, unknown>): void {
    const snapshot = parseUsageChanged(params);
    if (!snapshot) return;
    this.latestUsage = snapshot;
    this.callbacks.onUsage?.(snapshot);
  }

  private addLeg(params: Record<string, unknown>): void {
    const turnId = str(params.turnId);
    if (this.turnId && turnId && turnId !== this.turnId) return;
    this.legs = addTokenUsage(this.legs, parseTokenUsage(asRecord(params.usage)));
  }

  private get tokens(): TokenUsage | undefined {
    return this.usage ?? this.legs;
  }

  private readCompleted(params: Record<string, unknown>): void {
    const turnId = str(params.turnId);
    if (this.turnId && turnId && turnId !== this.turnId) return;
    this.terminal = str(params.terminal) ?? "failed";
    this.reason = str(params.reason);
    this.durationMs = num(params.durationMs);
    this.error = parseTurnError(asRecord(params.error), this.reason);
    this.usage = parseTokenUsage(asRecord(params.usage));
    this.wake();
  }

  private readItem(item: Record<string, unknown> | undefined, stage: "open" | "done"): void {
    const itemId = str(item?.itemId);
    if (!item || !itemId) return;
    // Only the turn's own items: a reminder child or a subagent is reported as its own kind.
    const kind = str(item.kind);
    if (kind === "agentMessage") this.readMessage(itemId, item, stage);
    else if (kind === "toolCall") this.readToolCall(itemId, item, stage);
    // `reasoning` is never streamed: it is the model's working, not the answer.
  }

  private message(itemId: string): MessageItem {
    let entry = this.messages.get(itemId);
    if (!entry) {
      entry = { phase: undefined, text: "", streamed: false };
      this.messages.set(itemId, entry);
      this.messageOrder.push(itemId);
    }
    return entry;
  }

  private readMessage(itemId: string, item: Record<string, unknown>, stage: "open" | "done"): void {
    const entry = this.message(itemId);
    entry.phase = str(item.messagePhase) ?? entry.phase;
    const text = typeof item.text === "string" ? item.text : "";
    if (stage === "done") {
      // A completed message is authoritative. Whatever deltas did not already
      // carry (all of it, when none were sent) still has to reach the stream.
      if (text.startsWith(entry.text) && text.length > entry.text.length) this.streamText(entry, text.slice(entry.text.length));
      if (text) entry.text = text;
    } else if (text && !entry.text) {
      this.streamText(entry, text);
      entry.text = text;
    }
  }

  private readDelta(params: Record<string, unknown>): void {
    const itemId = str(params.itemId);
    const delta = typeof params.delta === "string" ? params.delta : "";
    // `reasoning` summaries and tool output stream under other field names.
    if (!itemId || params.field !== "text" || !delta) return;
    const entry = this.messages.get(itemId) ?? this.message(itemId);
    entry.text += delta;
    this.streamText(entry, delta);
  }

  /** Text for the live view. A message that follows another one is set apart from it. */
  private streamText(entry: MessageItem, chunk: string): void {
    if (!chunk) return;
    const separator = !entry.streamed && this.streamedText ? "\n\n" : "";
    entry.streamed = true;
    this.streamedText = true;
    this.callbacks.onStream?.({ type: "text", content: separator + chunk });
  }

  private readToolCall(itemId: string, item: Record<string, unknown>, stage: "open" | "done"): void {
    const entry = this.tools.get(itemId) ?? { announced: false, name: undefined, args: undefined };
    this.tools.set(itemId, entry);
    entry.name = str(item.tool) ?? entry.name;
    entry.args = typeof item.args === "string" ? item.args : entry.args;
    const toolId = str(item.callId) ?? itemId;
    this.announceTool(entry, toolId, stage);
    const status = str(item.status);
    if (stage === "done" && status && status !== "inProgress") this.callbacks.onStream?.(toolResultDelta(entry, toolId, item, status));
  }

  /** Once per call, as soon as its name is known (or at the end, for a call first seen finished). */
  private announceTool(entry: ToolItem, toolId: string, stage: "open" | "done"): void {
    if (entry.announced || !(entry.name || stage === "done")) return;
    entry.announced = true;
    this.callbacks.onStream?.(toolUseDelta(entry, toolId));
  }

  /** The answer: the `finalAnswer` messages, in order; having none, the last message that said anything. */
  answer(): string {
    const texts = this.messageOrder.map((id) => this.messages.get(id)!);
    const final = texts.filter((m) => m.phase === "finalAnswer" && m.text.trim());
    if (final.length > 0) return final.map((m) => m.text).join("\n\n");
    return [...texts].reverse().find((m) => m.text.trim())?.text ?? "";
  }

  /** How full the context window is: the host's own reading, else the turn's input. */
  contextTokens(): number | undefined {
    if (this.contextUsed !== undefined && this.contextUsed > 0) return this.contextUsed;
    const u = this.tokens;
    if (!u) return undefined;
    const total = u.inputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
    return total > 0 ? total : undefined;
  }

  /**
   * What the turn became. `sessionId` is the conversation to resume next time
   * and `cost` is what the turn's usage comes to at the model's rates, when
   * those are known.
   *
   * The session exists by the time a turn does, so a result built here always
   * reports one turn: zero turns and zero cost is what the runner reads as a
   * stale resume id, and a failed turn is not that.
   */
  result(outcome: { terminationReason: string | null; costRates?: MuseModelCost }): EngineResult {
    const cost = museTurnCost(this.tokens, outcome.costRates);
    const base = {
      sessionId: this.sessionId,
      numTurns: 1,
      ...(cost === undefined ? {} : { cost }),
      ...(this.durationMs === undefined ? {} : { durationMs: this.durationMs }),
      ...(this.contextTokens() === undefined ? {} : { contextTokens: this.contextTokens()! }),
    };
    if (outcome.terminationReason) return { ...base, result: "", error: outcome.terminationReason };
    if (this.unqueued) return { ...base, result: "", error: "Muse Code unqueued the turn before it ran" };
    if (this.terminal === "cancelled") return { ...base, result: "", error: "Interrupted: Muse Code cancelled the turn" };
    if (this.terminal === "completed") {
      const answer = this.answer();
      if (answer.trim()) return { ...base, result: answer };
      return { ...base, result: "", error: "Muse Code finished the turn without an answer" };
    }
    return this.failure(base);
  }

  private failure(base: Pick<EngineResult, "sessionId" | "numTurns">): EngineResult {
    const error = this.error;
    if (!error) {
      return { ...base, result: "", error: this.reason ?? `Muse Code ended the turn as ${this.terminal ?? "failed"}` };
    }
    // Branch on the typed quota detail, never on the message text.
    if (error.quota) {
      return {
        ...base,
        result: "",
        error: error.message,
        rateLimit: { status: "rejected", resetsAt: Math.floor(error.quota.resetsAtMs / 1000), rateLimitType: error.quota.limitKind },
      };
    }
    if (error.kind === "authRequired") {
      return { ...base, result: "", error: `${MUSECODE_AUTH_HELP} (${error.message})` };
    }
    return { ...base, result: "", error: error.message };
  }
}
