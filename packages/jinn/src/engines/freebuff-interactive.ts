import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as pty from "node-pty";
import type { InterruptibleEngine, EngineRunOpts, EngineResult, RemoteTarget } from "../shared/types.js";
import type { RemoteExecutionConfig } from "../shared/config-types.js";
import { freebuffMaxConcurrent, type FreebuffEngineConfig } from "../shared/freebuff-config.js";
import { logger } from "../shared/logger.js";
import { JINN_HOME } from "../shared/paths.js";
import { resolveBin } from "../shared/resolve-bin.js";
import { buildEngineChildEnv } from "../shared/child-env.js";
import { neutralizeForPaste } from "../shared/skill-commands.js";
import { writeFreebuffUsage } from "../shared/freebuff-usage.js";
import { assertRemoteTarget, isRemoteTarget, sshDestination } from "../shared/remote-target.js";
import { employeeSessionEnv } from "../sessions/employee-env.js";
import { PtyLifecycleManager, processExitInterruption, ptyHostKey, type PtyExit, type PtyHandle } from "./pty-lifecycle.js";
import { PtyStreamManager, createPtyHandle, setCapped } from "./pty-stream.js";
import type { PtyControlEvent, PtyIdleSpawnOpts, PtySnapshotSubscription, PtyViewEngine } from "./pty-view-engine.js";
import { processStartFailure } from "../shared/process-start.js";
import { buildSshSpawnArgs, ensureRemoteReady, remoteNodeDir, requireRemoteEngineBin } from "./remote-stage.js";
import { FREEBUFF_COLS, FREEBUFF_ROWS, FreebuffTerminal } from "./freebuff-terminal.js";
import {
  parseFreebuffScreen,
  type FreebuffScreenInfo,
} from "./freebuff-screen.js";
import {
  chatKey,
  extractAnswer,
  lastUserMessage,
  firstPromptMatches,
  localChatSource,
  pickNewChat,
  type FreebuffChatRef,
  type FreebuffChatSource,
} from "./freebuff-chat.js";
import {
  choiceSatisfied,
  chooseInPicker,
  FreebuffPickerError,
  type PickerChoice,
  type PickerIO,
  type PickerKey,
} from "./freebuff-picker.js";
import {
  FreebuffFailure,
  UNKNOWN_SCREEN_LIMIT_MS,
  notSignedInMessage,
  screenFailure,
  unknownScreenFailure,
  type FreebuffPlace,
} from "./freebuff-failure.js";
import { FreebuffSlots } from "./freebuff-slots.js";
import { remoteChatSource, remoteSignedIn } from "./freebuff-remote.js";
import { scrapeAnswer } from "./freebuff-scrape.js";

/** A turn is bounded by the hour session it runs in, with room to spare. */
const TURN_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const POLL_MS = 200;
/** Idle after busy, with the footer up, for this long: the turn is over. */
const SETTLE_MS = 1_500;
/** Idle after busy but no footer: wait this long for one before reading the chat anyway. */
const FOOTER_GRACE_MS = 15_000;
/** The message was pasted and submitted, yet the screen never went busy. */
const NOT_ACCEPTED_MS = 30_000;
/** The chat file may lag the screen; wait this long for the answer to be in it. */
const ANSWER_WAIT_MS = 20_000;
const PICKER_OPEN_MS = 15_000;
const KEY_PATIENCE_MS = 1_500;
const KEY_SETTLE_MS = 150;
const PASTE_CHUNK = 8 * 1024;
const CURSOR_POSITION_RESPONSE = "\x1b[1;1R";

const KEY_BYTES: Record<PickerKey, string> = { up: "\x1b[A", down: "\x1b[B", tab: "\t", enter: "\r", escape: "\x1b" };

/** Why a turn stopped other than by finishing. */
type Stop =
  | { kind: "interrupt"; reason: string }
  | { kind: "exit"; exit: PtyExit | undefined; output: string };

class TurnStopped extends Error {
  constructor(readonly stop: Stop) {
    super(stop.kind === "interrupt" ? stop.reason : "freebuff exited");
    this.name = "TurnStopped";
  }
}

interface ActiveTurn {
  abort: AbortController;
}

/** Where a Freebuff process runs and which chat it holds. */
interface SpawnParams {
  cwd: string;
  bin?: string;
  /** `--continue` this chat. Unset starts a new one. */
  chatId?: string;
  /** The host to run on, for a remote employee. */
  target?: RemoteTarget & { remoteHost: string };
}

interface Live {
  proc: pty.IPty;
  handle: PtyHandle;
  terminal: FreebuffTerminal;
  place: FreebuffPlace;
  params: SpawnParams;
  /** The chat this process is in: known up front for `--continue`, found after the first turn otherwise. */
  chat?: FreebuffChatRef;
  /** Every chat that existed before this process started, so a new one can be told apart. */
  before: Set<string>;
  chats: FreebuffChatSource;
  /** Raw output kept until the TUI first shows itself, for a failed start. */
  startOutput: { text: string };
  booted: boolean;
  exited?: PtyExit;
}

export interface FreebuffEngineDeps {
  /** The `remote` block, read live so an edit takes effect on the next spawn. */
  remote?: () => RemoteExecutionConfig | undefined;
  /** `engines.freebuff`, read live. */
  config?: () => FreebuffEngineConfig | undefined;
  /** Test seams. */
  spawnPty?: typeof pty.spawn;
  localChats?: () => FreebuffChatSource;
}

/** Sleep that ends early, by throwing the signal's reason, when the turn stops. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function configHome(): string {
  return os.homedir();
}

/** The message the CLI is sent: Freebuff has no system-prompt flag, so a new chat's context goes in front of the first message. */
export function composeFreebuffMessage(opts: Pick<EngineRunOpts, "prompt" | "systemPrompt" | "resumeSessionId" | "platformContextRefresh" | "attachments">): string {
  const body = opts.attachments?.length
    ? `${opts.prompt}\n\nAttached files:\n${opts.attachments.map((a) => `- ${a}`).join("\n")}`
    : opts.prompt;
  const context = opts.resumeSessionId ? opts.platformContextRefresh : opts.systemPrompt;
  return context ? `${context}\n\n---\n\n${body}` : body;
}

/** The arguments the CLI is started with. `--trust-agents` skips the folder-trust prompt nobody is there to answer. */
export function buildFreebuffArgs(params: Pick<SpawnParams, "cwd" | "chatId">): string[] {
  return ["--cwd", params.cwd, "--trust-agents", ...(params.chatId ? ["--continue", params.chatId] : [])];
}

export class FreebuffInteractiveEngine implements InterruptibleEngine, PtyViewEngine {
  name = "freebuff" as const;
  private readonly active = new Map<string, ActiveTurn>();
  private readonly live = new Map<string, Live>();
  private readonly streams: PtyStreamManager;
  private readonly lastGeom = new Map<string, { cols: number; rows: number }>();
  private readonly slots: FreebuffSlots;
  private readonly readRemote: () => RemoteExecutionConfig | undefined;
  private readonly readConfig: () => FreebuffEngineConfig | undefined;
  private readonly spawnPty: typeof pty.spawn;
  private readonly localChats: () => FreebuffChatSource;

  constructor(private readonly lifecycle: PtyLifecycleManager, deps: FreebuffEngineDeps = {}) {
    this.readRemote = deps.remote ?? (() => undefined);
    this.readConfig = deps.config ?? (() => undefined);
    this.spawnPty = deps.spawnPty ?? pty.spawn;
    this.localChats = deps.localChats ?? (() => localChatSource());
    this.streams = new PtyStreamManager("Freebuff PTY", (id) => this.lifecycle.getWarm(id) !== undefined);
    this.slots = new FreebuffSlots({
      max: () => freebuffMaxConcurrent(this.readConfig()),
      evict: (id) => {
        logger.info(`FreebuffInteractiveEngine: stopping ${id}'s idle process to give its slot to a waiting turn`);
        this.lifecycle.releaseSession(id);
      },
    });
    this.lifecycle.onRelease((id) => {
      const live = this.live.get(id);
      this.live.delete(id);
      live?.terminal.dispose();
      this.slots.release(id);
    });
  }

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
      if (this.live.has(id)) {
        this.lifecycle.turnEnded(id);
        this.slots.markIdle(id);
      } else {
        this.slots.release(id);
      }
    }
  }

  private failureResult(err: unknown, opts: EngineRunOpts, id: string): EngineResult {
    const chatId = this.live.get(id)?.chat?.chatId ?? opts.resumeSessionId ?? "";
    if (err instanceof TurnStopped) {
      const stop = err.stop;
      if (stop.kind === "interrupt") {
        // A turn cut short leaves the process mid-answer; the next turn re-joins the chat in a fresh one.
        this.lifecycle.releaseSession(id);
        return { sessionId: chatId, result: "", error: stop.reason, conversationIntact: true };
      }
      // Before the TUI ever showed itself the process never ran this turn: a failed start, with what it printed.
      const live = this.live.get(id);
      const booted = live?.booted ?? false;
      if (!booted) return { sessionId: chatId, result: "", error: processStartFailure("freebuff", stop.exit, stop.output) };
      return { sessionId: chatId, result: "", error: processExitInterruption("freebuff", stop.exit), conversationIntact: true };
    }
    if (err instanceof FreebuffFailure) {
      // The process is in an unknown or unusable state; the next turn starts it afresh (and re-joins the chat).
      this.lifecycle.releaseSession(id);
      return { sessionId: chatId, result: "", error: err.message, conversationIntact: true, ...(err.rateLimit ? { rateLimit: err.rateLimit } : {}) };
    }
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`FreebuffInteractiveEngine: turn for ${id} failed: ${message}`);
    this.lifecycle.releaseSession(id);
    return { sessionId: chatId, result: "", error: `Freebuff interactive: ${message}`, conversationIntact: true };
  }

  private async runTurn(opts: EngineRunOpts, id: string, signal: AbortSignal): Promise<EngineResult> {
    const target = isRemoteTarget(opts) ? (opts as RemoteTarget & { remoteHost: string }) : undefined;
    const wantedChat = opts.resumeSessionId || undefined;

    // A process in another chat, folder or host is not this turn's: start over.
    const warm = this.live.get(id);
    if (warm && !this.reusable(warm, opts, target, wantedChat)) this.lifecycle.releaseSession(id);

    await this.slots.acquire(id, signal);
    let live = this.live.get(id);
    if (live) {
      this.lifecycle.turnStarted(id);
    } else {
      live = await this.spawnProcess(id, { cwd: opts.cwd || JINN_HOME, bin: opts.bin, chatId: wantedChat, target });
      this.lifecycle.adopt(id, live.handle, { turnRunning: true, hostKey: ptyHostKey(target) });
      this.lifecycle.turnStarted(id);
    }

    const ready = await this.waitForState(live, signal, (info) => info.state === "idle", { what: "start" });
    this.recordUsage(ready);

    await this.ensureModel(live, signal, { model: opts.model?.trim() || undefined, effortLevel: opts.effortLevel });

    const message = composeFreebuffMessage(opts);
    await this.submit(live, signal, neutralizeForPaste(message));
    const finish = await this.waitForFinish(live, signal, message);

    const { answer, usedScreen } = await this.readAnswer(live, signal, message, finish.lines);
    const info = finish.info;
    this.recordUsage(info);
    if (usedScreen) logger.warn(`FreebuffInteractiveEngine: ${id}: the answer was read from the screen, not the chat file`);
    return {
      sessionId: live.chat?.chatId ?? wantedChat ?? "",
      result: answer,
      numTurns: 1,
      cost: 0,
      ...(info.contextTokens !== undefined ? { contextTokens: info.contextTokens } : {}),
    };
  }

  private reusable(live: Live, opts: EngineRunOpts, target: (RemoteTarget & { remoteHost: string }) | undefined, wantedChat: string | undefined): boolean {
    if (live.exited) return false;
    const sameHost = (live.params.target?.remoteHost ?? "") === (target?.remoteHost ?? "") && (live.params.target?.remoteUser ?? "") === (target?.remoteUser ?? "");
    const cwd = target ? target.remoteCwd : (opts.cwd || JINN_HOME);
    const sameDir = (target ? live.params.target?.remoteCwd : live.params.cwd) === cwd;
    return sameHost && sameDir && (wantedChat ?? "") === (live.chat?.chatId ?? "");
  }

  // ── The process ────────────────────────────────────────────────────────────

  private chatSourceFor(target: (RemoteTarget & { remoteHost: string }) | undefined, id: string): FreebuffChatSource {
    return target ? remoteChatSource(target, id) : this.localChats();
  }

  private async assertSignedIn(target: (RemoteTarget & { remoteHost: string }) | undefined): Promise<void> {
    if (!target) {
      if (!fs.existsSync(path.join(configHome(), ".config", "manicode", "credentials.json"))) throw new FreebuffFailure(notSignedInMessage("local"));
      return;
    }
    // Unknown (ssh failed) is not "signed out": the screen will say if it really is.
    if (await remoteSignedIn(sshDestination(target)) === false) throw new FreebuffFailure(notSignedInMessage("remote"));
  }

  private async spawnProcess(id: string, params: SpawnParams): Promise<Live> {
    const { target } = params;
    await this.assertSignedIn(target);
    const chats = this.chatSourceFor(target, id);
    const before = new Set<string>();
    if (!params.chatId) {
      try {
        for (const chat of await chats.list()) before.add(chatKey(chat));
      } catch (err) {
        logger.warn(`FreebuffInteractiveEngine: could not list existing chats before spawning ${id}: ${err instanceof Error ? err.message : err}`);
      }
    }

    const geom = this.lastGeom.get(id);
    const cols = geom?.cols ?? FREEBUFF_COLS;
    const rows = geom?.rows ?? FREEBUFF_ROWS;
    const args = buildFreebuffArgs(target ? { cwd: target.remoteCwd!, chatId: params.chatId } : params);
    let proc: pty.IPty;
    if (target) {
      const remote = this.readRemote();
      assertRemoteTarget(target, remote);
      const readiness = await ensureRemoteReady(target, remote, { engine: "freebuff", allowWake: false });
      if (!readiness.ready) throw new FreebuffFailure(`remote host not ready: ${readiness.reason}`);
      const destination = sshDestination(target);
      const sshArgs = buildSshSpawnArgs({
        destination,
        tunnelPort: 0,
        gatewayPort: 0,
        reverseTunnel: false,
        remoteCwd: target.remoteCwd!,
        remoteEnv: { TERM: "xterm-256color" },
        // freebuff is a node program: put its node first, as the other remote engines do.
        pathPrepend: [remoteNodeDir(readiness.facts)],
        bin: requireRemoteEngineBin(destination, readiness.facts, "freebuff"),
        args,
      });
      logger.info(`FreebuffInteractiveEngine spawning REMOTE session on ${destination}:${target.remoteCwd} (chat: ${params.chatId ?? "new"})`);
      proc = this.spawnPty(resolveBin("ssh"), sshArgs, { name: "xterm-256color", cols, rows, cwd: JINN_HOME, env: this.sshClientEnv(id) });
    } else {
      const bin = resolveBin("freebuff", params.bin || this.readConfig()?.bin);
      logger.info(`FreebuffInteractiveEngine spawning ${bin} (chat: ${params.chatId ?? "new"})`);
      proc = this.spawnPty(bin, args, { name: "xterm-256color", cols, rows, cwd: params.cwd, env: this.childEnv(id) });
    }
    return this.wireProcess(id, proc, params, chats, before);
  }

  private childEnv(id: string): Record<string, string> {
    const env = buildEngineChildEnv(process.env, { scrubClaudeCode: true, scrubCodex: true });
    env.TERM = "xterm-256color";
    env.JINN_SESSION_ID = id;
    Object.assign(env, employeeSessionEnv(id));
    return env;
  }

  /** The local ssh client needs the ordinary environment (agent socket, config), not the engine-scrubbed one. */
  private sshClientEnv(id: string): Record<string, string> {
    return this.childEnv(id);
  }

  private wireProcess(id: string, proc: pty.IPty, params: SpawnParams, chats: FreebuffChatSource, before: Set<string>): Live {
    const handle = createPtyHandle(proc);
    const geom = this.lastGeom.get(id);
    const live: Live = {
      proc,
      handle,
      terminal: new FreebuffTerminal(geom?.cols ?? FREEBUFF_COLS, geom?.rows ?? FREEBUFF_ROWS),
      place: params.target ? "remote" : "local",
      params,
      ...(params.chatId ? { chat: { chatId: params.chatId, project: "" } } : {}),
      before,
      chats,
      startOutput: { text: "" },
      booted: false,
    };
    this.live.set(id, live);

    proc.onData((data) => {
      if (data.includes("\x1b[6n")) proc.write(CURSOR_POSITION_RESPONSE);
      live.terminal.write(data);
    });
    const tail = this.streams.attachWithOutputTail(id, proc, () => live.booted);
    live.startOutput = tail;
    proc.onExit((event) => {
      live.exited = event ?? { exitCode: 0, signal: 0 };
      // Judged before the release below drops it: a process we already replaced
      // or stopped is not the one the current turn is talking to.
      const isCurrent = this.live.get(id) === live;
      if (this.lifecycle.getWarm(id) === handle) {
        this.streams.onPtyExit(id, { exitCode: event?.exitCode ?? 0, signal: event?.signal ?? 0 });
        this.lifecycle.releaseSession(id);
      }
      if (isCurrent) this.active.get(id)?.abort.abort(new TurnStopped({ kind: "exit", exit: live.exited, output: tail.text }));
    });
    return live;
  }

  // ── The screen ─────────────────────────────────────────────────────────────

  private async screen(live: Live): Promise<{ lines: string[]; info: FreebuffScreenInfo }> {
    await live.terminal.settled();
    const lines = live.terminal.lines().map((l) => l.trimEnd());
    const info = parseFreebuffScreen(lines);
    if (info.state !== "unknown" && info.state !== "signed-out") live.booted = true;
    return { lines, info };
  }

  /**
   * Poll the screen until `done` says so. Fails the turn on the screens that mean
   * it cannot go on (signed out, no hours), and on one nothing recognises for a
   * minute, with that screen in the error.
   */
  private async waitForState(
    live: Live,
    signal: AbortSignal,
    done: (info: FreebuffScreenInfo) => boolean,
    opts: { what: string; timeoutMs?: number },
  ): Promise<FreebuffScreenInfo> {
    const startedAt = Date.now();
    let unknownSince: number | undefined;
    for (;;) {
      await sleep(POLL_MS, signal);
      const { lines, info } = await this.screen(live);
      const failure = screenFailure(info, live.place);
      if (failure) throw failure;
      if (done(info)) return info;
      if (info.state === "unknown") {
        unknownSince ??= Date.now();
        if (Date.now() - unknownSince >= UNKNOWN_SCREEN_LIMIT_MS) throw unknownScreenFailure(lines, Math.round(UNKNOWN_SCREEN_LIMIT_MS / 1000));
      } else {
        unknownSince = undefined;
      }
      if (opts.timeoutMs !== undefined && Date.now() - startedAt >= opts.timeoutMs) {
        throw new FreebuffFailure(`Freebuff did not reach its ${opts.what} screen within ${Math.round(opts.timeoutMs / 1000)}s`);
      }
    }
  }

  private type(live: Live, text: string): void {
    live.proc.write(text);
  }

  // ── Model and effort ───────────────────────────────────────────────────────

  private async ensureModel(live: Live, signal: AbortSignal, choice: PickerChoice): Promise<void> {
    const effortLevel = choice.effortLevel && choice.effortLevel !== "default" ? choice.effortLevel : undefined;
    const wanted: PickerChoice = { ...(choice.model ? { model: choice.model } : {}), ...(effortLevel ? { effortLevel } : {}) };
    if (!wanted.model && !wanted.effortLevel) return;
    const { info } = await this.screen(live);
    if (choiceSatisfied(wanted, info.statusBar)) return;

    logger.info(`FreebuffInteractiveEngine: switching to ${wanted.model ?? "(current model)"}${wanted.effortLevel ? ` • ${wanted.effortLevel}` : ""} (status bar: ${info.statusBar ? `${info.statusBar.modelLabel}${info.statusBar.effort ? ` • ${info.statusBar.effort}` : ""}` : "unreadable"})`);
    this.type(live, "/model");
    await sleep(400, signal);
    this.type(live, "\r");
    await this.waitForState(live, signal, (i) => i.state === "picker", { what: "model picker", timeoutMs: PICKER_OPEN_MS });

    const io: PickerIO = {
      screen: async () => (await this.screen(live)).lines,
      press: async (key) => { live.proc.write(KEY_BYTES[key]); },
      nextScreen: async (previous) => {
        const before = previous.join("\n");
        const deadline = Date.now() + KEY_PATIENCE_MS;
        let latest = previous;
        while (Date.now() < deadline) {
          await sleep(80, signal);
          latest = (await this.screen(live)).lines;
          if (latest.join("\n") !== before) {
            // The TUI drops keys that land mid-redraw: let it finish drawing.
            await sleep(KEY_SETTLE_MS, signal);
            return (await this.screen(live)).lines;
          }
        }
        return latest;
      },
    };
    try {
      const { warnings } = await chooseInPicker(io, wanted);
      for (const warning of warnings) logger.warn(`FreebuffInteractiveEngine: ${warning}`);
    } catch (err) {
      if (err instanceof FreebuffPickerError) throw new FreebuffFailure(`Freebuff model selection failed: ${err.message}`);
      throw err;
    }

    const after = await this.waitForState(live, signal, (i) => i.state === "idle", { what: "idle", timeoutMs: PICKER_OPEN_MS });
    if (!choiceSatisfied(wanted, after.statusBar)) {
      const shown = after.statusBar ? `${after.statusBar.modelLabel}${after.statusBar.effort ? ` • ${after.statusBar.effort}` : ""}` : "unreadable";
      throw new FreebuffFailure(`Freebuff did not switch to ${wanted.model ?? "the requested model"}${wanted.effortLevel ? ` • ${wanted.effortLevel}` : ""}; its status bar shows ${shown}`);
    }
  }

  // ── Sending and finishing ──────────────────────────────────────────────────

  /** Bracketed paste, so a multi-line message arrives as one message and its newlines do not submit; then Enter. */
  private async submit(live: Live, signal: AbortSignal, text: string): Promise<void> {
    live.proc.write("\x1b[200~");
    for (let i = 0; i < text.length; i += PASTE_CHUNK) {
      live.proc.write(text.slice(i, i + PASTE_CHUNK));
      if (text.length > PASTE_CHUNK) await sleep(15, signal);
    }
    live.proc.write("\x1b[201~");
    await sleep(Math.min(3_000, 300 + Math.floor(text.length / 40)), signal);
    live.proc.write("\r");
  }

  /**
   * Busy, then idle again with the `⎘ • 11s` footer up, held for a moment: the
   * turn is over. The footer of an earlier turn can still be on screen, so
   * nothing counts until this turn has been seen busy.
   */
  private async waitForFinish(live: Live, signal: AbortSignal, sent: string): Promise<{ info: FreebuffScreenInfo; lines: string[] }> {
    const submittedAt = Date.now();
    let sawBusy = false;
    let idleSince: number | undefined;
    let unknownSince: number | undefined;
    for (;;) {
      await sleep(POLL_MS, signal);
      const { lines, info } = await this.screen(live);
      const failure = screenFailure(info, live.place);
      if (failure) throw failure;

      if (info.state === "busy") {
        sawBusy = true;
        idleSince = undefined;
        unknownSince = undefined;
        continue;
      }
      if (info.state === "idle" && sawBusy) {
        idleSince ??= Date.now();
        const settled = Date.now() - idleSince;
        if ((info.turnFooter && settled >= SETTLE_MS) || settled >= FOOTER_GRACE_MS) {
          if (!info.turnFooter) logger.warn("FreebuffInteractiveEngine: the turn went idle without its footer; reading the chat anyway");
          return { info, lines };
        }
        continue;
      }
      if (info.state === "unknown") {
        unknownSince ??= Date.now();
        if (Date.now() - unknownSince >= UNKNOWN_SCREEN_LIMIT_MS) throw unknownScreenFailure(lines, Math.round(UNKNOWN_SCREEN_LIMIT_MS / 1000));
      } else {
        unknownSince = undefined;
      }
      if (!sawBusy && info.state === "idle" && Date.now() - submittedAt >= NOT_ACCEPTED_MS) {
        // A turn short enough to have come and gone between polls leaves its chat behind.
        if (await this.answerInChat(live, sent)) return { info, lines };
        throw new FreebuffFailure(`Freebuff did not take the message: its input stayed idle for ${Math.round(NOT_ACCEPTED_MS / 1000)}s after submit:\n${lines.filter((l) => l.trim()).slice(-12).join("\n")}`);
      }
    }
  }

  // ── The answer ─────────────────────────────────────────────────────────────

  /** Find the chat this process created (once), by what was sent into it. */
  private async locateChat(live: Live, sent: string): Promise<FreebuffChatRef | undefined> {
    if (live.chat?.project) return live.chat;
    const listing = await live.chats.list();
    if (live.chat) {
      // `--continue <id>`: the id is known, the project directory it lives under is not.
      const found = listing.find((c) => c.chatId === live.chat!.chatId);
      if (found) live.chat = { chatId: found.chatId, project: found.project };
      return live.chat.project ? live.chat : undefined;
    }
    const claimed = new Set<string>();
    for (const other of this.live.values()) if (other !== live && other.chat?.project) claimed.add(chatKey(other.chat));
    const picked = pickNewChat(listing, { before: live.before, claimed, sentPrompt: sent });
    if (picked.chat) {
      if (picked.ambiguous) logger.warn("FreebuffInteractiveEngine: several new chats opened with the same words; using the newest");
      live.chat = picked.chat;
      return live.chat;
    }
    // A pasted message leaves no first prompt in the chat's meta: read the chat to see what it was sent.
    for (const candidate of picked.unresolved.slice(0, 4)) {
      const ref = { chatId: candidate.chatId, project: candidate.project };
      if (firstPromptMatches(lastUserMessage(await live.chats.readMessages(ref)), sent)) {
        live.chat = ref;
        return ref;
      }
    }
    return undefined;
  }

  private async answerInChat(live: Live, sent: string): Promise<boolean> {
    try {
      const chat = await this.locateChat(live, sent);
      if (!chat) return false;
      return extractAnswer(await live.chats.readMessages(chat)) !== undefined;
    } catch {
      return false;
    }
  }

  private async readAnswer(live: Live, signal: AbortSignal, sent: string, lines: string[]): Promise<{ answer: string; usedScreen: boolean }> {
    const deadline = Date.now() + ANSWER_WAIT_MS;
    let lastError: unknown;
    for (;;) {
      try {
        const chat = await this.locateChat(live, sent);
        if (chat) {
          const messages = await live.chats.readMessages(chat);
          const answer = extractAnswer(messages);
          // The reply must be to THIS message: a chat file that has not caught up
          // yet still ends in the previous turn's completed answer.
          if (answer && firstPromptMatches(lastUserMessage(messages), sent)) return { answer: answer.text, usedScreen: false };
        }
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
    if (info.hoursRemaining === undefined && info.sessionLeftMinutes === undefined) return;
    writeFreebuffUsage({
      observedAtMs: Date.now(),
      ...(info.hoursRemaining !== undefined ? { hoursRemaining: info.hoursRemaining } : {}),
      ...(info.hoursTotal !== undefined ? { hoursTotal: info.hoursTotal } : {}),
      ...(info.sessionLeftMinutes !== undefined ? { sessionLeftMinutes: info.sessionLeftMinutes } : {}),
      ...(info.statusBar ? { modelLabel: info.statusBar.modelLabel } : {}),
    });
    logger.info(
      `Freebuff: ${info.hoursRemaining !== undefined ? `${info.hoursRemaining}/${info.hoursTotal ?? "?"} hours left today` : "hours unknown"}`
      + `${info.sessionLeftMinutes !== undefined ? `, ${info.sessionLeftMinutes}m left in this session` : ""}`
      + `${info.contextTokens !== undefined ? `, ${info.contextTokens} context tokens (${info.contextPct ?? "?"}%)` : ""}`,
    );
  }

  // ── The dashboard's terminal ───────────────────────────────────────────────

  ensureIdleSpawn(id: string, opts: PtyIdleSpawnOpts): void {
    if (this.active.has(id)) return;
    if (opts.cols && opts.rows) setCapped(this.lastGeom, id, { cols: opts.cols, rows: opts.rows });
    const target = isRemoteTarget(opts) ? (opts as RemoteTarget & { remoteHost: string }) : undefined;
    const wantedChat = opts.engineSessionId || undefined;
    const warm = this.live.get(id);
    if (warm) {
      if (!warm.exited && (wantedChat === undefined || wantedChat === warm.chat?.chatId)) return;
      this.lifecycle.releaseSession(id);
    }
    // A view never waits for a slot and never displaces a turn: no slot, no terminal.
    if (!this.slots.tryAcquireIdle(id)) {
      logger.info(`FreebuffInteractiveEngine: no free slot (maxConcurrent ${freebuffMaxConcurrent(this.readConfig())}); not starting a terminal for ${id}`);
      return;
    }
    void (async () => {
      try {
        const live = await this.spawnProcess(id, { cwd: opts.cwd || JINN_HOME, bin: opts.bin, chatId: wantedChat, target });
        this.lifecycle.adopt(id, live.handle, { hostKey: ptyHostKey(target) });
      } catch (err) {
        logger.warn(`FreebuffInteractiveEngine: could not start a terminal for ${id}: ${err instanceof Error ? err.message : err}`);
        this.slots.release(id);
      }
    })();
  }

  subscribeWithSnapshot(sessionId: string, cb: (data: Buffer) => void, onControl?: (event: PtyControlEvent) => void): PtySnapshotSubscription {
    return this.streams.subscribeWithSnapshot(sessionId, cb, onControl);
  }

  restartPty(sessionId: string, opts: PtyIdleSpawnOpts): void {
    this.kill(sessionId, "Interrupted: terminal restart requested");
    this.ensureIdleSpawn(sessionId, opts);
  }

  writeStdin(sessionId: string, text: string): void {
    const live = this.live.get(sessionId);
    if (live) live.proc.write(neutralizeForPaste(text) + "\r");
  }

  writeRaw(sessionId: string, data: string): void {
    this.live.get(sessionId)?.proc.write(data);
  }

  resizePty(sessionId: string, cols: number, rows: number): void {
    setCapped(this.lastGeom, sessionId, { cols, rows });
    this.streams.resize(sessionId, cols, rows);
    const live = this.live.get(sessionId);
    if (!live) return;
    live.terminal.resize(cols, rows);
    try { live.proc.resize(cols, rows); } catch { /* gone */ }
  }

  setViewing(sessionId: string, viewing: boolean): void {
    if (viewing) this.lifecycle.viewerEnter(sessionId);
    else this.lifecycle.viewerLeave(sessionId);
  }

  hasWarmPty(sessionId: string): boolean {
    return this.lifecycle.getWarm(sessionId) !== undefined;
  }

  isTurnRunning(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  kill(sessionId: string, reason = "Interrupted"): void {
    this.active.get(sessionId)?.abort.abort(new TurnStopped({ kind: "interrupt", reason: reason.startsWith("Interrupted") ? reason : `Interrupted: ${reason}` }));
    this.lifecycle.releaseSession(sessionId);
  }

  killAll(): void {
    this.slots.rejectAll(new Error("Interrupted: gateway shutting down"));
    for (const id of [...this.active.keys()]) this.kill(id, "Interrupted: gateway shutting down");
    this.lifecycle.killAll();
  }

  /** Recycle idle warm PTYs only (org-reload); a turn in flight is never interrupted. */
  killIdle(): void {
    this.lifecycle.releaseIdle((id) => this.active.has(id));
  }

  isAlive(sessionId: string): boolean {
    return this.active.has(sessionId) || this.lifecycle.getWarm(sessionId) !== undefined;
  }
}
