import * as pty from "node-pty";
import type { RemoteExecutionConfig } from "../shared/config-types.js";
import { freebuffMaxConcurrent, type FreebuffEngineConfig } from "../shared/freebuff-config.js";
import { logger } from "../shared/logger.js";
import { JINN_HOME } from "../shared/paths.js";
import { neutralizeForPaste } from "../shared/skill-commands.js";
import { isRemoteTarget } from "../shared/remote-target.js";
import { PtyLifecycleManager, ptyHostKey, type PtyExit, type PtyHandle } from "./pty-lifecycle.js";
import { PtyStreamManager, createPtyHandle, setCapped } from "./pty-stream.js";
import type { PtyControlEvent, PtyIdleSpawnOpts, PtySnapshotSubscription, PtyViewEngine } from "./pty-view-engine.js";
import { FREEBUFF_COLS, FREEBUFF_ROWS, FreebuffTerminal } from "./freebuff-terminal.js";
import { localChatSource, type FreebuffChatRef, type FreebuffChatSource } from "./freebuff-chat.js";
import type { FreebuffPlace } from "./freebuff-failure.js";
import type { DriverTarget } from "./freebuff-driver.js";
import { FreebuffSlots } from "./freebuff-slots.js";
import { remoteChatSource } from "./freebuff-remote.js";
import {
  assertSignedIn,
  chatsBefore,
  freebuffChildEnv,
  spawnLocalFreebuff,
  spawnRemoteFreebuff,
  type FreebuffTarget,
  type SpawnParams,
  type SpawnPty,
} from "./freebuff-spawn.js";

const CURSOR_POSITION_RESPONSE = "\x1b[1;1R";

/** Why a turn stopped other than by finishing. */
export type Stop =
  | { kind: "interrupt"; reason: string }
  | { kind: "exit"; exit: PtyExit | undefined; output: string };

export class TurnStopped extends Error {
  constructor(readonly stop: Stop) {
    super(stop.kind === "interrupt" ? stop.reason : "freebuff exited");
    this.name = "TurnStopped";
  }
}

export interface ActiveTurn {
  abort: AbortController;
}

export interface Live {
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
  spawnPty?: SpawnPty;
  localChats?: () => FreebuffChatSource;
}

const hostOf = (target: FreebuffTarget | undefined): string => (target ? `${target.remoteUser ?? ""}@${target.remoteHost}` : "");
const dirOf = (target: FreebuffTarget | undefined, cwd: string): string | undefined => (target ? target.remoteCwd : cwd);
const chatIdOf = (chatId: string | undefined): string => chatId ?? "";

/** Whether a process is still the one a turn wants: same host, same folder, same chat. */
export function reusableProcess(
  live: Pick<Live, "params" | "chat" | "exited">,
  want: { target?: FreebuffTarget; cwd: string; chatId?: string },
): boolean {
  if (live.exited) return false;
  if (hostOf(live.params.target) !== hostOf(want.target)) return false;
  if (dirOf(live.params.target, live.params.cwd) !== dirOf(want.target, want.cwd)) return false;
  return chatIdOf(want.chatId) === chatIdOf(live.chat?.chatId);
}

/**
 * The Freebuff processes: who is alive, where, and on whose slot, and the
 * dashboard's terminal on them. A turn (see the engine that extends this) types
 * into a process from here; the terminal view looks at the same one.
 */
export class FreebuffProcessPool implements PtyViewEngine {
  protected readonly active = new Map<string, ActiveTurn>();
  protected readonly live = new Map<string, Live>();
  protected readonly slots: FreebuffSlots;
  protected readonly readRemote: () => RemoteExecutionConfig | undefined;
  protected readonly readConfig: () => FreebuffEngineConfig | undefined;
  private readonly streams: PtyStreamManager;
  private readonly lastGeom = new Map<string, { cols: number; rows: number }>();
  private readonly spawnPty: SpawnPty;
  private readonly localChats: () => FreebuffChatSource;

  constructor(protected readonly lifecycle: PtyLifecycleManager, deps: FreebuffEngineDeps = {}) {
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

  // ── The process ────────────────────────────────────────────────────────────

  protected async spawnProcess(id: string, params: SpawnParams): Promise<Live> {
    const { target } = params;
    await assertSignedIn(target);
    const chats = target ? remoteChatSource(target, id) : this.localChats();
    const before = params.chatId ? new Set<string>() : await chatsBefore(chats, id);
    const geom = this.lastGeom.get(id) ?? { cols: FREEBUFF_COLS, rows: FREEBUFF_ROWS };
    const env = freebuffChildEnv(id);
    const proc = target
      ? await spawnRemoteFreebuff({ spawnPty: this.spawnPty, target, remote: this.readRemote(), chatId: params.chatId, geom, env })
      : spawnLocalFreebuff(this.spawnPty, params, this.readConfig()?.bin, geom, env);
    return this.wireProcess({ id, proc, params, chats, before, geom });
  }

  private wireProcess(w: { id: string; proc: pty.IPty; params: SpawnParams; chats: FreebuffChatSource; before: Set<string>; geom: { cols: number; rows: number } }): Live {
    const { id, proc, params, chats, before, geom } = w;
    const handle = createPtyHandle(proc);
    const live: Live = {
      proc,
      handle,
      terminal: new FreebuffTerminal(geom.cols, geom.rows),
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
    live.startOutput = this.streams.attachWithOutputTail(id, proc, () => live.booted);
    proc.onExit((event) => this.onProcessExit(id, live, handle, event));
    return live;
  }

  private onProcessExit(id: string, live: Live, handle: PtyHandle, event: PtyExit | undefined): void {
    live.exited = event ?? { exitCode: 0, signal: 0 };
    // Judged before the release below drops it: a process we already replaced
    // or stopped is not the one the current turn is talking to.
    const isCurrent = this.live.get(id) === live;
    if (this.lifecycle.getWarm(id) === handle) {
      this.streams.onPtyExit(id, { exitCode: event?.exitCode ?? 0, signal: event?.signal ?? 0 });
      this.lifecycle.releaseSession(id);
    }
    if (isCurrent) this.active.get(id)?.abort.abort(new TurnStopped({ kind: "exit", exit: live.exited, output: live.startOutput.text }));
  }

  protected driverTarget(live: Live): DriverTarget {
    return {
      proc: live.proc,
      terminal: live.terminal,
      place: live.place,
      markBooted: () => { live.booted = true; },
    };
  }

  // ── The dashboard's terminal ───────────────────────────────────────────────

  ensureIdleSpawn(id: string, opts: PtyIdleSpawnOpts): void {
    if (this.active.has(id)) return;
    if (opts.cols && opts.rows) setCapped(this.lastGeom, id, { cols: opts.cols, rows: opts.rows });
    const wantedChat = opts.engineSessionId || undefined;
    if (!this.dropStaleTerminal(id, wantedChat)) return;
    // A view never waits for a slot and never displaces a turn: no slot, no terminal.
    if (!this.slots.tryAcquireIdle(id)) {
      logger.info(`FreebuffInteractiveEngine: no free slot (maxConcurrent ${freebuffMaxConcurrent(this.readConfig())}); not starting a terminal for ${id}`);
      return;
    }
    const target = isRemoteTarget(opts) ? (opts as FreebuffTarget) : undefined;
    void this.startTerminal(id, { cwd: opts.cwd || JINN_HOME, bin: opts.bin, chatId: wantedChat, target });
  }

  /** Whether a new terminal should be started: false when a good one is already up. */
  private dropStaleTerminal(id: string, wantedChat: string | undefined): boolean {
    const warm = this.live.get(id);
    if (!warm) return true;
    if (!warm.exited && (wantedChat === undefined || wantedChat === warm.chat?.chatId)) return false;
    this.lifecycle.releaseSession(id);
    return true;
  }

  private async startTerminal(id: string, params: SpawnParams): Promise<void> {
    try {
      const live = await this.spawnProcess(id, params);
      this.lifecycle.adopt(id, live.handle, { hostKey: ptyHostKey(params.target) });
    } catch (err) {
      logger.warn(`FreebuffInteractiveEngine: could not start a terminal for ${id}: ${err instanceof Error ? err.message : err}`);
      this.slots.release(id);
    }
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
