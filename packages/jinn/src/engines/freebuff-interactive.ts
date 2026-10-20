import type { InterruptibleEngine, EngineRunOpts, EngineResult } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { JINN_HOME } from "../shared/paths.js";
import { neutralizeForPaste } from "../shared/skill-commands.js";
import { describeUsage, usageFromScreen, writeFreebuffUsage } from "../shared/freebuff-usage.js";
import { isRemoteTarget } from "../shared/remote-target.js";
import { processExitInterruption } from "./pty-lifecycle.js";
import { processStartFailure } from "../shared/process-start.js";
import type { FreebuffScreenInfo } from "./freebuff-screen.js";
import type { FreebuffChatRef } from "./freebuff-chat.js";
import { FreebuffFailure, SessionReleased } from "./freebuff-failure.js";
import { FreebuffDriver } from "./freebuff-driver.js";
import { composeFreebuffMessage } from "./freebuff-message.js";
import { pickerModelFor } from "./freebuff-model.js";
import { AnswerReader } from "./freebuff-answer.js";
import { FreebuffProcessPool } from "./freebuff-pool.js";
import { TurnStopped, reusableProcess, type ActiveTurn, type Live, type Stop } from "./freebuff-live.js";
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

/**
 * Freebuff, driven through its screen: each turn types the message into the real
 * TUI and reads the answer from its chat file. The processes, their slots and the
 * dashboard's terminal are {@link FreebuffProcessPool}'s.
 */
export class FreebuffInteractiveEngine extends FreebuffProcessPool implements InterruptibleEngine {
  name = "freebuff" as const;
  private readonly answers = new AnswerReader((live) => [...this.live.values()].filter((other) => other !== live));

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
      const done = await this.runTurn(opts, id, turn);
      return { ...done, durationMs: Date.now() - startedAt };
    } catch (err) {
      return await this.failureResult(err, opts, id, turn);
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

  private async failureResult(err: unknown, opts: EngineRunOpts, id: string, turn: ActiveTurn): Promise<EngineResult> {
    const chatId = turn.live?.chat?.chatId ?? opts.resumeSessionId ?? "";
    if (err instanceof TurnStopped) return await this.stoppedResult(err.stop, id, turn, chatId);
    // The process is in an unknown or unusable state; the next turn starts it afresh (and re-joins the chat).
    this.lifecycle.releaseSession(id);
    if (err instanceof FreebuffFailure) {
      return { sessionId: chatId, result: "", error: err.message, conversationIntact: true, ...(err.rateLimit ? { rateLimit: err.rateLimit } : {}) };
    }
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`FreebuffInteractiveEngine: turn for ${id} failed: ${message}`);
    return { sessionId: chatId, result: "", error: `Freebuff interactive: ${message}`, conversationIntact: true };
  }

  /**
   * A turn that was stopped, not finished. It reads the turn's OWN process, not the
   * map: a process that exited has been released and dropped from it by now, and a
   * crash mid-answer must not read as "did not start", which the runner answers by
   * sending the message again.
   */
  private async stoppedResult(stop: Stop, id: string, turn: ActiveTurn, chatId: string): Promise<EngineResult> {
    if (stop.kind === "interrupt") {
      // A turn cut short leaves the process mid-answer; the next turn re-joins the chat in a fresh one.
      this.lifecycle.releaseSession(id);
      return { sessionId: chatId, result: "", error: stop.reason, conversationIntact: true };
    }
    // Before the TUI ever showed itself the process never ran this turn: a failed start, with what it printed.
    if (!turn.live?.booted) return { sessionId: chatId, result: "", error: processStartFailure("freebuff", stop.exit, stop.output) };
    const sessionId = (await this.chatAfterCrash(turn))?.chatId ?? chatId;
    return { sessionId, result: "", error: processExitInterruption("freebuff", stop.exit), conversationIntact: true };
  }

  /** The chat the message went into, if it got far enough to be written down. */
  private async chatAfterCrash(turn: ActiveTurn): Promise<FreebuffChatRef | undefined> {
    if (!turn.live || turn.sent === undefined) return turn.live?.chat;
    try {
      return await this.answers.chatOf(turn.live, turn.sent);
    } catch {
      return turn.live.chat;
    }
  }

  private async runTurn(opts: EngineRunOpts, id: string, turn: ActiveTurn, rejoined = false): Promise<EngineResult> {
    const target = isRemoteTarget(opts) ? (opts as FreebuffTarget) : undefined;
    const wantedChat = opts.resumeSessionId || undefined;
    const signal = turn.abort.signal;
    const live = await this.processFor(id, signal, { cwd: opts.cwd || JINN_HOME, bin: opts.bin, chatId: wantedChat, target });
    turn.live = live;
    const driver = new FreebuffDriver(this.driverTarget(live), signal);

    try {
      await this.getReady(driver, opts);
      return await this.sendAndRead(live, driver, { turn, opts, remoteCwd: target?.remoteCwd });
    } catch (err) {
      if (!(err instanceof SessionReleased) || rejoined) throw err;
      // The process outlived its hour session (nothing of this turn was taken). A fresh one starts a new session in the same chat,
      // and this turn keeps its slot: a queued turn must not take it while this one starts over.
      logger.info(`FreebuffInteractiveEngine: ${id}'s Freebuff session was released (${err.message.trim()}); starting the process afresh`);
      this.releaseKeepingSlot(id);
      return await this.runTurn(opts, id, turn, true);
    }
  }

  /** The TUI is up and showing the model the turn asked for. */
  private async getReady(driver: FreebuffDriver, opts: EngineRunOpts): Promise<void> {
    this.recordUsage(await driver.waitForState((info) => info.state === "idle", { what: "start" }));
    await driver.ensureModel({ model: pickerModelFor(opts.model, this.readConfig()?.model), effortLevel: opts.effortLevel });
  }

  private async sendAndRead(live: Live, driver: FreebuffDriver, ctx: { turn: ActiveTurn; opts: EngineRunOpts; remoteCwd: string | undefined }): Promise<EngineResult> {
    const { turn, opts } = ctx;
    const message = composeFreebuffMessage(opts, ctx.remoteCwd);
    turn.sent = message;
    const before = await this.answers.messageCount(live);
    const baseline = live.chat ? await live.chats.statMessages(live.chat).catch(() => undefined) : undefined;
    await driver.submit(neutralizeForPaste(message));
    const finish = await driver.waitForFinish(() => this.answers.answered(live, message, before));
    const { answer, usedScreen } = await this.answers.read(live, turn.abort.signal, { sent: message, before, baseline }, finish.lines);
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

  private recordUsage(info: FreebuffScreenInfo): void {
    const usage = usageFromScreen(info);
    if (!usage) return;
    writeFreebuffUsage(usage);
    logger.info(describeUsage(usage, { tokens: info.contextTokens, pct: info.contextPct }));
  }
}
