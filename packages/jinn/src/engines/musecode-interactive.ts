import * as pty from "node-pty";
import type { EngineResult, EngineRunOpts, InterruptibleEngine, ResolvedMcpConfig } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { JINN_HOME } from "../shared/paths.js";
import { resolveBin } from "../shared/resolve-bin.js";
import { buildEngineChildEnv } from "../shared/child-env.js";
import { employeeSessionEnv } from "../sessions/employee-env.js";
import { CONVERSATION_KEPT } from "./musecode-turn-text.js";
import { PtyLifecycleManager } from "./pty-lifecycle.js";
import { PtyStreamManager, createPtyHandle, setCapped } from "./pty-stream.js";
import type { PtyControlEvent, PtyIdleSpawnOpts, PtySnapshotSubscription, PtyViewEngine } from "./pty-view-engine.js";
import { buildMuseViewArgs, type MuseViewArgs } from "./musecode-view-args.js";

/** Why a work turn cannot run on the terminal view's engine. */
export const MUSECODE_VIEW_ONLY =
  "Muse Code's terminal view is view-only; work turns run on the Muse Code engine.";

/** How long a headless turn waits for a view it has closed to let go of the session. */
const VIEW_EXIT_WAIT_MS = 4000;

export interface MusecodeInteractiveDeps {
  /** `engines.musecode.bin`. */
  bin?: () => string | undefined;
  /** What a turn of this session would be launched with: the employee's `cliFlags` and its MCP set. */
  resolveLaunch?: (sessionId: string) => { cliFlags?: string[]; resolvedMcp?: ResolvedMcpConfig } | undefined;
}

/**
 * The dashboard terminal for a Muse Code session: Muse's own TUI,
 * `muse resume <id>` in a PTY, on the conversation the session's turns write to.
 *
 * VIEW-ONLY, like Hermes's. Muse keeps one owner per session: while a TUI has a
 * session open, a `muse serve` host (which is what a turn is) is refused with
 * `sessionInUse`. The reverse is not guarded: a TUI opened while a turn's host
 * holds the session gets in and the two interleave. So work turns never run
 * here, the headless engine says plainly when the terminal holds its session,
 * and the dashboard keeps the terminal shut while a turn is running.
 */
export class MusecodeInteractiveEngine implements InterruptibleEngine, PtyViewEngine {
  name = "musecode" as const;
  private streams: PtyStreamManager;
  private lastGeom = new Map<string, { cols: number; rows: number }>();
  /** The conversation each warm view was opened on: "" for a fresh TUI. */
  private opened = new Map<string, string>();
  private viewers = new Map<string, number>();
  private exits = new Map<string, Promise<void>>();

  constructor(private lifecycle: PtyLifecycleManager, private deps: MusecodeInteractiveDeps = {}) {
    this.streams = new PtyStreamManager("Muse Code PTY", (id) => this.lifecycle.getWarm(id) !== undefined);
    lifecycle.onRelease((id) => {
      this.opened.delete(id);
      this.exits.delete(id);
      // The lifecycle's own viewer count goes with the process, so this does too:
      // a terminal that restarts is entered again by the socket that was on it.
      this.viewers.delete(id);
    });
  }

  /** v1: the view is view-only. Work turns run through `MusecodeEngine`. */
  async run(opts: EngineRunOpts): Promise<EngineResult> {
    // Said as a failed turn on a conversation that is intact, never as a dead
    // session: the runner clears a resume id for a result with no work and no
    // such mark, and a message sent in the CLI view must not cost the session its conversation.
    return { sessionId: opts.resumeSessionId ?? "", result: "", error: MUSECODE_VIEW_ONLY, ...(opts.resumeSessionId ? CONVERSATION_KEPT : {}) };
  }

  // ── PtyViewEngine ─────────────────────────────────────────────────────────

  ensureIdleSpawn(jinnSessionId: string, opts: PtyIdleSpawnOpts): void {
    if (opts.cols && opts.rows) setCapped(this.lastGeom, jinnSessionId, { cols: opts.cols, rows: opts.rows });
    if (this.lifecycle.getWarm(jinnSessionId)) {
      // A TUI opened before the session had a conversation is a different one
      // from what its turns have written since; show the real one.
      const opened = this.opened.get(jinnSessionId);
      if (!opts.engineSessionId || opened === opts.engineSessionId) return;
      logger.info(`Muse Code view for ${jinnSessionId} was opened on ${opened || "a new conversation"}; reopening on ${opts.engineSessionId}`);
      this.kill(jinnSessionId, "Reopening the terminal on the session's conversation");
    }
    const handle = this.spawn(jinnSessionId, opts);
    this.lifecycle.adopt(jinnSessionId, handle);
  }

  hasWarmPty(sessionId: string): boolean {
    return this.lifecycle.getWarm(sessionId) !== undefined;
  }

  subscribeWithSnapshot(
    sessionId: string,
    cb: (data: Buffer) => void,
    onControl?: (event: PtyControlEvent) => void,
  ): PtySnapshotSubscription {
    return this.streams.subscribeWithSnapshot(sessionId, cb, onControl);
  }

  restartPty(sessionId: string, opts: PtyIdleSpawnOpts): void {
    this.kill(sessionId, "Interrupted: terminal restart requested");
    this.ensureIdleSpawn(sessionId, opts);
  }

  setViewing(sessionId: string, viewing: boolean): void {
    // Counted here because the lifecycle keeps its count private.
    const count = Math.max(0, (this.viewers.get(sessionId) ?? 0) + (viewing ? 1 : -1));
    if (count > 0) this.viewers.set(sessionId, count);
    else this.viewers.delete(sessionId);
    if (viewing) this.lifecycle.viewerEnter(sessionId);
    else this.lifecycle.viewerLeave(sessionId);
  }

  writeStdin(sessionId: string, text: string): void {
    this.proc(sessionId)?.write(`${text}\r`);
  }

  writeRaw(sessionId: string, data: string): void {
    this.proc(sessionId)?.write(data);
  }

  resizePty(sessionId: string, cols: number, rows: number): void {
    setCapped(this.lastGeom, sessionId, { cols, rows });
    this.streams.resize(sessionId, cols, rows);
    try { this.proc(sessionId)?.resize(cols, rows); } catch { /* gone */ }
  }

  // ── InterruptibleEngine ────────────────────────────────────────────────────

  kill(sessionId: string, _reason = "Interrupted"): void {
    this.lifecycle.releaseSession(sessionId);
  }

  isAlive(sessionId: string): boolean {
    return this.lifecycle.getWarm(sessionId) !== undefined;
  }

  killAll(): void {
    this.lifecycle.killAll();
  }

  killIdle(): void {
    this.lifecycle.releaseIdle(() => false);
  }

  /**
   * Close the session's terminal if nobody is looking at it, and wait for Muse to
   * let go of the conversation. A warm view outlives the dashboard tab for a
   * while, and until it is gone a turn on the same session is refused.
   * A terminal someone has open is left alone.
   */
  async releaseUnviewed(sessionId: string): Promise<void> {
    if (!this.lifecycle.getWarm(sessionId) || (this.viewers.get(sessionId) ?? 0) > 0) return;
    const exited = this.exits.get(sessionId);
    logger.info(`Closing the idle Muse Code terminal for ${sessionId} ahead of a turn`);
    this.kill(sessionId, "Interrupted: closing the terminal for a turn");
    if (!exited) return;
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<void>((resolve) => { timer = setTimeout(resolve, VIEW_EXIT_WAIT_MS); timer.unref?.(); });
    try { await Promise.race([exited, bound]); } finally { if (timer) clearTimeout(timer); }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private proc(sessionId: string): pty.IPty | undefined {
    return (this.lifecycle.getWarm(sessionId) as { _proc?: pty.IPty } | undefined)?._proc;
  }

  /** The binary and argv a terminal for this session starts with. */
  private launchFor(jinnSessionId: string, opts: PtyIdleSpawnOpts): { bin: string; view: MuseViewArgs } {
    const launch = this.deps.resolveLaunch?.(jinnSessionId);
    const view = buildMuseViewArgs({
      engineSessionId: opts.engineSessionId,
      model: opts.model,
      cliFlags: launch?.cliFlags,
      resolvedMcp: launch?.resolvedMcp,
    });
    if (view.skippedServers.length > 0) logger.warn(`Muse Code terminal: MCP server(s) ${view.skippedServers.join(", ")} cannot be named on the command line and are left out`);
    return { bin: resolveBin("muse", this.deps.bin?.() ?? opts.bin), view };
  }

  private spawn(jinnSessionId: string, opts: PtyIdleSpawnOpts): ReturnType<typeof createPtyHandle> {
    const { bin, view } = this.launchFor(jinnSessionId, opts);
    const geom = this.lastGeom.get(jinnSessionId) ?? { cols: 120, rows: 40 };
    logger.info(`MusecodeInteractiveEngine spawning ${bin} ${opts.engineSessionId ? "resume" : "(new conversation)"} (geom: ${geom.cols}x${geom.rows})`);
    const proc = pty.spawn(bin, view.args, {
      name: "xterm-256color",
      ...geom,
      cwd: opts.cwd || JINN_HOME,
      env: { ...this.buildEnv(jinnSessionId), ...view.env },
    });
    const handle = createPtyHandle(proc);
    this.streams.attach(jinnSessionId, proc);
    this.opened.set(jinnSessionId, opts.engineSessionId ?? "");
    this.exits.set(jinnSessionId, this.watchExit(jinnSessionId, proc, handle));
    return handle;
  }

  /** Release the session's entry when its current process exits by itself; resolves once the process is gone. */
  private watchExit(jinnSessionId: string, proc: pty.IPty, handle: ReturnType<typeof createPtyHandle>): Promise<void> {
    return new Promise<void>((resolve) => {
      proc.onExit((event) => {
        if (this.lifecycle.getWarm(jinnSessionId) === handle) {
          this.streams.onPtyExit(jinnSessionId, event ?? { exitCode: 0, signal: 0 });
          this.lifecycle.releaseSession(jinnSessionId);
        }
        resolve();
      });
    });
  }

  /** The turn's own child environment, so the terminal sees the credentials and company tools a turn does. */
  private buildEnv(sessionId: string): Record<string, string> {
    const env = buildEngineChildEnv(process.env, { scrubClaudeCode: true, scrubCodex: true });
    env.TERM = "xterm-256color";
    env.JINN_SESSION_ID = sessionId;
    Object.assign(env, employeeSessionEnv(sessionId));
    return env;
  }
}
