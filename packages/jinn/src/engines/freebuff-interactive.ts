import type { InterruptibleEngine, EngineRunOpts, EngineResult } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { JINN_HOME } from "../shared/paths.js";
import { neutralizeForPaste } from "../shared/skill-commands.js";
import { describeUsage, usageFromScreen, writeFreebuffUsage } from "../shared/freebuff-usage.js";
import { isRemoteTarget } from "../shared/remote-target.js";
import { processExitInterruption } from "./pty-lifecycle.js";
import { processStartFailure } from "../shared/process-start.js";
import type { FreebuffScreenInfo } from "./freebuff-screen.js";
import {
  chatKey,
  extractAnswer,
  firstPromptMatches,
  lastUserMessage,
  locateChat,
  type FreebuffChatRef,
} from "./freebuff-chat.js";
import { FreebuffFailure, SessionReleased } from "./freebuff-failure.js";
import { FreebuffDriver, sleep } from "./freebuff-driver.js";
import { composeFreebuffMessage } from "./freebuff-message.js";
import { FreebuffProcessPool } from "./freebuff-pool.js";
import { TurnStopped, reusableProcess, type ActiveTurn, type Live, type Stop } from "./freebuff-live.js";
import { scrapeAnswer } from "./freebuff-scrape.js";
import { buildFreebuffArgs, type FreebuffTarget, type SpawnParams } from "./freebuff-spawn.js";

export { buildFreebuffArgs, composeFreebuffMessage, reusableProcess };
export { remoteLocationNote } from "./freebuff-message.js";
export type { FreebuffEngineDeps } from "./freebuff-live.js";

/** The model finished (or gave up) without saying anything: an error on its side, which the screen may name. */
function emptyAnswer(lines: readonly string[]): FreebuffFailure {
  const shown = lines.filter((l) => l.trim()).slice(-8).join("\n");
  return new FreebuffFailure(`Freebuff ended the turn without an answer; the end of its screen:\n${shown}`);
}

/** A turn is bounded by the hour session it runs in, with room to spare. */
const TURN_TIMEOUT_MS = 2 * 60 * 60 * 1000;
/** The chat file may lag the screen; wait this long for the answer to be in it. */
const ANSWER_WAIT_MS = 20_000;

/**
 * Freebuff, driven through its screen: each turn types the message into the real
 * TUI and reads the answer from its chat file. The processes, their slots and the
 * dashboard's terminal are {@link FreebuffProcessPool}'s.
 */
export class FreebuffInteractiveEngine extends FreebuffProcessPool implements InterruptibleEngine {
  name = "freebuff" as const;

  // ── A turn ─────────────────────────────────────────────────────────────────

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    const id = opts.sessionId;
    if (!id) throw new Error("FreebuffInteractiveEngine.run requires opts.sessionId");
    if (this.active.has(id)) {
      return { sessionId: opts.resumeSessionId ?? "", result: "", error: "Freebuff interactive engine: a turn is already running for this session", conversationIntact: true };
    }

    const turn: ActiveTurn = { abort: new AbortController() };
    this.active.set(id, turn);
    const startedAt = Date.now();
    const hardTimeout = setTimeout(() => turn.abort.abort(new TurnStopped({ kind: "interrupt", reason: "Freebuff interactive turn timed out" })), TURN_TIMEOUT_MS);
    hardTimeout.unref?.();
    try {
      const done = await this.runTurn(opts, id, turn.abort.signal);
      return { ...done, durationMs: Date.now() - startedAt };
    } catch (err) {
      return this.failureResult(err, opts, id);
    } finally {
      clearTimeout(hardTimeout);
      this.active.delete(id);
      this.afterTurn(id);
    }
  }

  /** The process stays warm for the next turn, and its slot may now be taken over; or it is gone, and so is its slot. */
  private afterTurn(id: string): void {
    if (!this.live.has(id)) {
      this.slots.release(id);
      return;
    }
    this.lifecycle.turnEnded(id);
    this.slots.markIdle(id);
  }

  private failureResult(err: unknown, opts: EngineRunOpts, id: string): EngineResult {
    const chatId = this.live.get(id)?.chat?.chatId ?? opts.resumeSessionId ?? "";
    if (err instanceof TurnStopped) return this.stoppedResult(err.stop, id, chatId);
    // The process is in an unknown or unusable state; the next turn starts it afresh (and re-joins the chat).
    this.lifecycle.releaseSession(id);
    if (err instanceof FreebuffFailure) {
      return { sessionId: chatId, result: "", error: err.message, conversationIntact: true, ...(err.rateLimit ? { rateLimit: err.rateLimit } : {}) };
    }
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`FreebuffInteractiveEngine: turn for ${id} failed: ${message}`);
    return { sessionId: chatId, result: "", error: `Freebuff interactive: ${message}`, conversationIntact: true };
  }

  private stoppedResult(stop: Stop, id: string, chatId: string): EngineResult {
    if (stop.kind === "interrupt") {
      // A turn cut short leaves the process mid-answer; the next turn re-joins the chat in a fresh one.
      this.lifecycle.releaseSession(id);
      return { sessionId: chatId, result: "", error: stop.reason, conversationIntact: true };
    }
    // Before the TUI ever showed itself the process never ran this turn: a failed start, with what it printed.
    if (!this.live.get(id)?.booted) return { sessionId: chatId, result: "", error: processStartFailure("freebuff", stop.exit, stop.output) };
    return { sessionId: chatId, result: "", error: processExitInterruption("freebuff", stop.exit), conversationIntact: true };
  }

  private async runTurn(opts: EngineRunOpts, id: string, signal: AbortSignal, rejoined = false): Promise<EngineResult> {
    const target = isRemoteTarget(opts) ? (opts as FreebuffTarget) : undefined;
    const wantedChat = opts.resumeSessionId || undefined;
    const live = await this.processFor(id, signal, { cwd: opts.cwd || JINN_HOME, bin: opts.bin, chatId: wantedChat, target });
    const driver = new FreebuffDriver(this.driverTarget(live), signal);

    try {
      await this.getReady(driver, opts);
      return await this.sendAndRead(live, driver, signal, opts, target?.remoteCwd);
    } catch (err) {
      if (!(err instanceof SessionReleased) || rejoined) throw err;
      // The process outlived its hour session (nothing of this turn was taken). A fresh one starts a new session in the same chat.
      logger.info(`FreebuffInteractiveEngine: ${id}'s Freebuff session was released (${err.message.trim()}); starting the process afresh`);
      this.lifecycle.releaseSession(id);
      return await this.runTurn(opts, id, signal, true);
    }
  }

  /** The TUI is up and showing the model the turn asked for. */
  private async getReady(driver: FreebuffDriver, opts: EngineRunOpts): Promise<void> {
    this.recordUsage(await driver.waitForState((info) => info.state === "idle", { what: "start" }));
    await driver.ensureModel({ model: opts.model?.trim() || undefined, effortLevel: opts.effortLevel });
  }

  private async sendAndRead(live: Live, driver: FreebuffDriver, signal: AbortSignal, opts: EngineRunOpts, remoteCwd: string | undefined): Promise<EngineResult> {
    const message = composeFreebuffMessage(opts, remoteCwd);
    const before = await this.messageCount(live);
    await driver.submit(neutralizeForPaste(message));
    const finish = await driver.waitForFinish(() => this.answerInChat(live, message, before));
    const { answer, usedScreen } = await this.readAnswer(live, signal, message, before, finish.lines);
    this.recordUsage(finish.info);
    if (!answer.trim()) throw emptyAnswer(finish.lines);
    if (usedScreen) logger.warn(`FreebuffInteractiveEngine: ${opts.sessionId}: the answer was read from the screen, not the chat file`);
    return {
      sessionId: live.chat?.chatId ?? opts.resumeSessionId ?? "",
      result: answer,
      numTurns: 1,
      cost: 0,
      ...(finish.info.contextTokens !== undefined ? { contextTokens: finish.info.contextTokens } : {}),
    };
  }

  /** The process this turn types into: a warm one that is still the right one, else a new one. */
  private async processFor(id: string, signal: AbortSignal, params: SpawnParams): Promise<Live> {
    await this.whenStarted(id);
    const warm = this.live.get(id);
    if (warm && !reusableProcess(warm, { target: params.target, cwd: params.cwd, chatId: params.chatId })) this.lifecycle.releaseSession(id);

    await this.slots.acquire(id, signal);
    const existing = this.live.get(id);
    if (existing) {
      this.lifecycle.turnStarted(id);
      return existing;
    }
    const live = await this.spawnProcess(id, params);
    this.lifecycle.turnStarted(id);
    return live;
  }

  // ── The answer ─────────────────────────────────────────────────────────────

  /** The chat this process is in, found by what was sent into it the first time. */
  private async chatOf(live: Live, sent: string): Promise<FreebuffChatRef | undefined> {
    const claimed = new Set<string>();
    for (const other of this.live.values()) if (other !== live && other.chat?.project) claimed.add(chatKey(other.chat));
    const chat = await locateChat(live.chats, {
      known: live.chat,
      before: live.before,
      claimed,
      sent,
      onAmbiguous: () => logger.warn("FreebuffInteractiveEngine: several new chats opened with the same words; using the newest"),
    });
    if (chat) live.chat = chat;
    return chat;
  }

  /**
   * The reply to `sent`, if the chat file already holds it complete. It must be a
   * reply to THIS message: a chat file that has not caught up still ends in the
   * previous turn's completed answer, and a message sent twice ("continue") matches
   * itself. So the file must hold more messages than the chat had when this one went
   * in, as well as end in this message's text.
   */
  private async chatAnswer(live: Live, sent: string, before: number): Promise<string | undefined> {
    const chat = await this.chatOf(live, sent);
    if (!chat) return undefined;
    const messages = await live.chats.readMessages(chat);
    if (!Array.isArray(messages) || messages.length <= before) return undefined;
    const answer = extractAnswer(messages);
    return answer && firstPromptMatches(lastUserMessage(messages), sent) ? answer.text : undefined;
  }

  /** How many messages the chat holds right now (0 for a chat that does not exist yet), from its small meta file. */
  private async messageCount(live: Live): Promise<number> {
    if (!live.chat) return 0;
    try {
      const listing = await live.chats.list();
      const mine = listing.find((c) => c.chatId === live.chat?.chatId && (!live.chat.project || c.project === live.chat.project));
      return mine?.meta?.messageCount ?? 0;
    } catch {
      return 0;
    }
  }

  private async answerInChat(live: Live, sent: string, before: number): Promise<boolean> {
    try {
      return (await this.chatAnswer(live, sent, before)) !== undefined;
    } catch {
      return false;
    }
  }

  private async readAnswer(live: Live, signal: AbortSignal, sent: string, before: number, lines: string[]): Promise<{ answer: string; usedScreen: boolean }> {
    const deadline = Date.now() + ANSWER_WAIT_MS;
    let lastError: unknown;
    for (;;) {
      try {
        const answer = await this.chatAnswer(live, sent, before);
        if (answer !== undefined) return { answer, usedScreen: false };
      } catch (err) {
        lastError = err;
      }
      if (Date.now() >= deadline) break;
      await sleep(500, signal);
    }
    if (lastError) logger.warn(`FreebuffInteractiveEngine: could not read the chat file: ${lastError instanceof Error ? lastError.message : lastError}`);
    const scraped = scrapeAnswer(lines);
    if (!scraped) throw new FreebuffFailure("Freebuff finished the turn but its answer could not be read from the chat file or the screen");
    return { answer: scraped, usedScreen: true };
  }

  private recordUsage(info: FreebuffScreenInfo): void {
    const usage = usageFromScreen(info);
    if (!usage) return;
    writeFreebuffUsage(usage);
    logger.info(describeUsage(usage, { tokens: info.contextTokens, pct: info.contextPct }));
  }
}
