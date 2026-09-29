import * as pty from "node-pty";
import type { EngineResult, EngineRunOpts, InterruptibleEngine, ResolvedMcpConfig } from "../shared/types.js";
import type { OpencodeMode } from "../shared/config-types.js";
import { logger } from "../shared/logger.js";
import { JINN_HOME } from "../shared/paths.js";
import { resolveBin } from "../shared/resolve-bin.js";
import { isRemoteTarget } from "../shared/remote-target.js";
import { neutralizeForPaste } from "../shared/skill-commands.js";
import { PtyStreamManager, setCapped } from "./pty-stream.js";
import type { PtyControlEvent, PtyIdleSpawnOpts, PtySnapshotSubscription, PtyViewEngine } from "./pty-view-engine.js";
import type { OpencodeEngine } from "./opencode.js";
import type { OpencodeServer, OpencodeServerPool, OpencodeServerSpec } from "./opencode-server.js";
import { buildOpencodeViewArgs } from "./opencode-protocol.js";
import { cleanEnv, REMOTE_ENV_DENY } from "./opencode-launch.js";
import { buildSshSpawnArgs, remoteNodeDir, remoteSessionBinDir } from "./remote-stage.js";

/** Why the view refuses in `run` mode. The dashboard hides the toggle then
 *  (`engineOffersPty`), so this only reaches a view opened before a mode flip. */
export const OPENCODE_VIEW_NEEDS_SERVER_MODE =
  "The OpenCode terminal needs engines.opencode.mode: server in config.yaml";

/** How long an attach client outlives the last terminal socket. Long enough to
 *  cover a page reload, short enough that a closed tab stops holding ~300 MB. */
export const VIEW_CLOSE_GRACE_MS = 60_000;
/** How long a view opened during a new chat's first turn waits for that turn
 *  to create its opencode session before attaching without one. The session is
 *  created as soon as the server answers, so this is only ever a bound. */
export const FIRST_SESSION_WAIT_MS = 15_000;
export const HELD_FOR_TURN_NOTICE =
  "A Jinn turn is running in this session; your message will be sent to it when the turn finishes.";
const CURSOR_POSITION_RESPONSE = "\x1b[1;1R";

interface View {
  proc: pty.IPty;
  server: OpencodeServer;
  /** The opencode session the TUI is showing, as far as we know. */
  engineSessionId?: string;
}

export interface OpencodeInteractiveDeps {
  mode: () => OpencodeMode;
  /** The session's MCP set, exactly as a turn would resolve it, so a server
   *  the terminal starts is the server the next turn wants. */
  resolveMcp?: (sessionId: string) => ResolvedMcpConfig | undefined;
  /** `engines.opencode.bin`. */
  bin?: () => string | undefined;
}

/**
 * The dashboard terminal for an opencode session: opencode's own TUI, run as
 * `opencode attach` against the session's server (`opencode-server.ts`).
 *
 * The TUI is only a CLIENT here. Turns go to the server, not through this PTY,
 * so the view shows them live, closing the view never touches a turn, and a
 * turn does not need the view to exist. It holds the server open while it
 * runs and is closed a short while after the last terminal socket leaves.
 *
 * Text sent from the dashboard's composer goes to the server's API rather than
 * being typed into the TUI, which is less fragile than driving a line editor
 * over a PTY. While a Jinn turn is running in the session it is HELD, and sent
 * when the turn ends: opencode would otherwise run it inside the turn's busy
 * period, delaying the turn's end behind the operator's prompt. Either way the
 * prompt runs in opencode's session and is NOT mirrored into the Jinn chat
 * transcript (a documented v1 limitation, as for codex and grok).
 *
 * Work turns are not routed through this class: `run` delegates to the
 * OpencodeEngine, which is what the gateway's engine map holds.
 */
export class OpencodeInteractiveEngine implements InterruptibleEngine, PtyViewEngine {
  name = "opencode" as const;
  private views = new Map<string, View>();
  private spawning = new Set<string>();
  /** Terminal sockets per session (subscribeWithSnapshot … unsubscribe). */
  private sockets = new Map<string, number>();
  private closeTimers = new Map<string, NodeJS.Timeout>();
  private lastOpts = new Map<string, PtyIdleSpawnOpts>();
  private lastGeom = new Map<string, { cols: number; rows: number }>();
  /** Composer text waiting for a Jinn turn in the session to end. */
  private held = new Map<string, string[]>();
  /** Views waiting for a running turn to name its opencode session. */
  private sessionWaiters = new Map<string, Array<() => void>>();
  private streams: PtyStreamManager;

  constructor(
    private readonly work: OpencodeEngine,
    private readonly pool: OpencodeServerPool,
    private readonly deps: OpencodeInteractiveDeps,
  ) {
    this.streams = new PtyStreamManager("OpenCode PTY", (id) => this.views.has(id));
    // A turn named a (new) opencode session: put the TUI on it.
    pool.onEngineSession((id, engineSessionId) => {
      this.wakeSessionWaiters(id);
      const view = this.views.get(id);
      if (!view || view.engineSessionId === engineSessionId) return;
      this.reattach(id, view, engineSessionId);
    });
    // The server went away under the view (replaced for a turn, crashed, capped).
    pool.onReleased((id) => {
      this.wakeSessionWaiters(id);
      this.closeView(id);
    });
    // A Jinn turn ended: send what the operator typed while it ran.
    work.onServerTurnEnd((id) => {
      this.wakeSessionWaiters(id);
      this.releaseHeld(id);
    });
    // A server came up while someone has the terminal open: attach to it.
    pool.onStarted((server) => {
      const id = server.sessionId;
      const opts = this.lastOpts.get(id);
      if (opts && (this.sockets.get(id) ?? 0) > 0 && !this.views.has(id)) this.ensureIdleSpawn(id, opts);
    });
  }

  run(opts: EngineRunOpts): Promise<EngineResult> {
    return this.work.run(opts);
  }

  kill(sessionId: string, reason?: string): void {
    this.work.kill(sessionId, reason);
  }

  isAlive(sessionId: string): boolean {
    return this.work.isAlive(sessionId);
  }

  killAll(): void {
    for (const id of [...this.views.keys()]) this.closeView(id);
  }

  /** Nothing idle belongs to the view: servers are the pool's. */
  killIdle(): void {
    /* no-op */
  }

  livePids(): number[] {
    return [...this.views.values()].map((v) => v.proc.pid);
  }

  hasWarmPty(sessionId: string): boolean {
    return this.views.has(sessionId);
  }

  ensureIdleSpawn(sessionId: string, opts: PtyIdleSpawnOpts): void {
    if (opts.cols && opts.rows) setCapped(this.lastGeom, sessionId, { cols: opts.cols, rows: opts.rows });
    setCapped(this.lastOpts, sessionId, opts);
    this.startView(sessionId, opts, false);
  }

  /** `existingOnly`: attach only to a server something else started. */
  private startView(sessionId: string, opts: PtyIdleSpawnOpts, existingOnly: boolean): void {
    if (this.views.has(sessionId) || this.spawning.has(sessionId)) return;
    if (this.deps.mode() !== "server") {
      this.streams.reportError(sessionId, OPENCODE_VIEW_NEEDS_SERVER_MODE);
      return;
    }
    this.spawning.add(sessionId);
    void this.openView(sessionId, opts, existingOnly)
      .catch(() => "done" as const)
      .then((outcome) => {
        this.spawning.delete(sessionId);
        if (outcome === "server-gone") this.followSuccessor(sessionId);
      });
  }

  /**
   * The server went while the view waited for the first session. Attach to
   * its successor if one is running or starting — a turn's — but never start
   * one: the server may have been stopped on purpose (gateway shutdown, a flip
   * back to `run` mode), and a server started now would outlive that. A
   * successor started later reaches the view through `onStarted`.
   */
  private followSuccessor(sessionId: string): void {
    const opts = this.lastOpts.get(sessionId);
    if (!opts || this.views.has(sessionId) || (this.sockets.get(sessionId) ?? 0) === 0) return;
    if (!this.pool.hasServer(sessionId)) return;
    this.startView(sessionId, opts, true);
  }

  restartPty(sessionId: string, opts: PtyIdleSpawnOpts): void {
    this.closeView(sessionId);
    this.ensureIdleSpawn(sessionId, opts);
  }

  subscribeWithSnapshot(
    sessionId: string,
    cb: (data: Buffer) => void,
    onControl?: (event: PtyControlEvent) => void,
  ): PtySnapshotSubscription {
    const sub = this.streams.subscribeWithSnapshot(sessionId, cb, onControl);
    this.sockets.set(sessionId, (this.sockets.get(sessionId) ?? 0) + 1);
    this.cancelClose(sessionId);
    let gone = false;
    return {
      ...sub,
      unsubscribe: () => {
        sub.unsubscribe();
        if (gone) return;
        gone = true;
        const left = Math.max(0, (this.sockets.get(sessionId) ?? 1) - 1);
        if (left === 0) this.sockets.delete(sessionId);
        else this.sockets.set(sessionId, left);
        if (left === 0) this.scheduleClose(sessionId);
      },
    };
  }

  /** Viewing is tracked by socket, not by tab focus: a hidden tab keeps its
   *  socket, and closing the client under it would leave a dead terminal. */
  setViewing(_sessionId: string, _viewing: boolean): void {
    /* see subscribeWithSnapshot */
  }

  writeStdin(sessionId: string, text: string): void {
    const view = this.views.get(sessionId);
    if (!view) return;
    if (this.work.isAlive(sessionId)) {
      const waiting = this.held.get(sessionId) ?? [];
      waiting.push(text);
      setCapped(this.held, sessionId, waiting);
      this.streams.reportError(sessionId, HELD_FOR_TURN_NOTICE);
      return;
    }
    this.send(sessionId, view, text);
  }

  private releaseHeld(sessionId: string): void {
    const waiting = this.held.get(sessionId);
    if (!waiting?.length) return;
    this.held.delete(sessionId);
    const view = this.views.get(sessionId);
    if (!view) {
      logger.warn(`OpenCode terminal for session ${sessionId} closed with ${waiting.length} held message(s) unsent`);
      return;
    }
    for (const text of waiting) this.send(sessionId, view, text);
  }

  private send(sessionId: string, view: View, text: string): void {
    const engineSessionId = view.engineSessionId ?? view.server.engineSessionId;
    if (engineSessionId) {
      void this.pool.promptAsync(sessionId, engineSessionId, text).catch((err) => {
        this.streams.reportError(sessionId, `could not send the prompt: ${err instanceof Error ? err.message : String(err)}`);
      });
      return;
    }
    // No opencode session yet: type it into the TUI, which will create one.
    view.proc.write(`\x1b[200~${neutralizeForPaste(text)}\x1b[201~\r`);
  }

  writeRaw(sessionId: string, data: string): void {
    this.views.get(sessionId)?.proc.write(data);
  }

  resizePty(sessionId: string, cols: number, rows: number): void {
    setCapped(this.lastGeom, sessionId, { cols, rows });
    this.streams.resize(sessionId, cols, rows);
    try { this.views.get(sessionId)?.proc.resize(cols, rows); } catch { /* gone */ }
  }

  // ── The attach client ────────────────────────────────────────────────────

  private async openView(sessionId: string, opts: PtyIdleSpawnOpts, existingOnly: boolean): Promise<"done" | "server-gone"> {
    let held = false;
    try {
      const server = await this.pool.acquire(sessionId, this.specFor(sessionId, opts), { reuseAny: true, existingOnly });
      held = true;
      if (this.views.has(sessionId)) return "done";
      const engineSessionId = await this.sessionToShow(sessionId, server, opts);
      if (this.pool.get(sessionId) !== server) {
        // Stopped during the wait. The pool dropped its holds with it, and a
        // release now would take one from its successor — a running turn's.
        held = false;
        return "server-gone";
      }
      if (this.views.has(sessionId)) return "done";
      const proc = this.spawnView(sessionId, server, engineSessionId);
      this.views.set(sessionId, { proc, server, ...(engineSessionId ? { engineSessionId } : {}) });
      held = false; // the view owns the hold now, and drops it when it exits
      this.wire(sessionId, proc);
      if ((this.sockets.get(sessionId) ?? 0) === 0) this.scheduleClose(sessionId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`OpenCode terminal for session ${sessionId} could not start: ${message}`);
      this.streams.reportError(sessionId, `failed to start terminal: ${message}`);
    } finally {
      if (held) this.pool.release(sessionId);
    }
    return "done";
  }

  /**
   * The opencode session to attach on. A new chat's first turn creates its
   * session just after the server comes up, which is when a terminal opened
   * with the chat gets here: wait for it rather than attach bare — a bare
   * client sits on opencode's home screen.
   */
  private async sessionToShow(sessionId: string, server: OpencodeServer, opts: PtyIdleSpawnOpts): Promise<string | undefined> {
    const known = () => server.engineSessionId ?? opts.engineSessionId;
    if (!known() && this.work.isAlive(sessionId)) await this.untilEngineSession(sessionId);
    return known();
  }

  /** Stream an attach client to the terminal, and clear the view when it
   *  exits — unless it has already been replaced ({@link reattach}). */
  private wire(sessionId: string, proc: pty.IPty): void {
    this.streams.attach(sessionId, proc);
    proc.onData((data) => {
      if (data.includes("\x1b[6n")) proc.write(CURSOR_POSITION_RESPONSE);
    });
    proc.onExit((event) => {
      const view = this.views.get(sessionId);
      if (view?.proc !== proc) return;
      this.views.delete(sessionId);
      this.pool.release(sessionId);
      this.streams.onPtyExit(sessionId, event ?? { exitCode: 0, signal: 0 });
    });
  }

  /**
   * Move the view onto another opencode session by replacing its attach client
   * with one started on it (`-s`). The server stays held throughout.
   *
   * Not `POST /tui/select-session`: opencode delivers that only to TUIs already
   * connected to the server's event stream, and an attach client takes seconds
   * to get there (~3 s on build-host with 1.18.31, more over ssh or on a Pi).
   * One that misses it stays on its home screen for good, while the turn runs
   * unseen. A turn names a session the view is not on only for a new
   * chat's first turn or a resume that found its session gone, so the restart
   * is rare.
   */
  private reattach(sessionId: string, view: View, engineSessionId: string): void {
    const previous = view.proc;
    let proc: pty.IPty;
    try {
      proc = this.spawnView(sessionId, view.server, engineSessionId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`OpenCode terminal for session ${sessionId} could not move to ${engineSessionId}: ${message}`);
      this.streams.reportError(sessionId, `could not show the opencode session: ${message}`);
      return;
    }
    view.proc = proc;
    view.engineSessionId = engineSessionId;
    this.wire(sessionId, proc);
    try { previous.kill(); } catch { /* gone */ }
  }

  /** Resolves when a turn names the session's opencode session, the turn or
   *  the server ends, or {@link FIRST_SESSION_WAIT_MS} passes. */
  private untilEngineSession(sessionId: string): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const rest = (this.sessionWaiters.get(sessionId) ?? []).filter((w) => w !== wake);
        if (rest.length) this.sessionWaiters.set(sessionId, rest);
        else this.sessionWaiters.delete(sessionId);
        resolve();
      }, FIRST_SESSION_WAIT_MS);
      timer.unref?.();
      this.sessionWaiters.set(sessionId, [...(this.sessionWaiters.get(sessionId) ?? []), wake]);
    });
  }

  private wakeSessionWaiters(sessionId: string): void {
    const waiters = this.sessionWaiters.get(sessionId);
    if (!waiters) return;
    this.sessionWaiters.delete(sessionId);
    for (const wake of waiters) wake();
  }

  private spawnView(sessionId: string, server: OpencodeServer, engineSessionId: string | undefined): pty.IPty {
    const geom = this.lastGeom.get(sessionId);
    const size = { cols: geom?.cols ?? 120, rows: geom?.rows ?? 40 };
    const args = buildOpencodeViewArgs(server.hostUrl, engineSessionId);
    logger.info(
      `OpenCode terminal attaching for session ${sessionId} to ${server.hostKey} ${server.hostUrl} `
      + `(opencode session: ${engineSessionId ?? "none yet"})`,
    );
    const where = server.remote;
    if (!where) {
      return pty.spawn(server.bin, args, {
        name: "xterm-256color",
        ...size,
        cwd: server.cwd,
        env: { ...cleanEnv(sessionId), TERM: "xterm-256color", OPENCODE_SERVER_PASSWORD: server.password },
      });
    }
    const sshArgs = buildSshSpawnArgs({
      destination: where.destination,
      tunnelPort: where.staging.tunnelPort,
      gatewayPort: 0,
      reverseTunnel: false,
      remoteCwd: where.remoteCwd,
      remoteEnv: { JINN_HOME: where.staging.sessionHome, JINN_SESSION_ID: sessionId, OPENCODE_DISABLE_AUTOUPDATE: "1" },
      // Carries OPENCODE_SERVER_PASSWORD, staged when the server started.
      envFile: where.staging.envFilePath,
      unsetRemoteEnv: REMOTE_ENV_DENY,
      pathPrepend: [remoteNodeDir(where.facts), remoteSessionBinDir(where.staging.sessionHome)],
      bin: server.bin,
      args,
      allocateTty: true,
    });
    return pty.spawn(resolveBin("ssh"), sshArgs, {
      name: "xterm-256color",
      ...size,
      cwd: JINN_HOME,
      env: { ...cleanEnv(sessionId), TERM: "xterm-256color" },
    });
  }

  private specFor(sessionId: string, opts: PtyIdleSpawnOpts): OpencodeServerSpec {
    const resolvedMcp = this.deps.resolveMcp?.(sessionId);
    const bin = opts.bin || this.deps.bin?.();
    return {
      cwd: opts.cwd || JINN_HOME,
      ...(bin ? { bin } : {}),
      ...(resolvedMcp ? { resolvedMcp } : {}),
      ...(isRemoteTarget(opts)
        ? {
          remoteHost: opts.remoteHost,
          ...(opts.remoteUser ? { remoteUser: opts.remoteUser } : {}),
          ...(opts.remoteCwd ? { remoteCwd: opts.remoteCwd } : {}),
        }
        : {}),
    };
  }

  private closeView(sessionId: string): void {
    this.cancelClose(sessionId);
    const view = this.views.get(sessionId);
    if (!view) return;
    this.views.delete(sessionId);
    this.pool.release(sessionId);
    try { view.proc.kill(); } catch { /* gone */ }
  }

  private scheduleClose(sessionId: string): void {
    this.cancelClose(sessionId);
    if (!this.views.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.closeTimers.delete(sessionId);
      if ((this.sockets.get(sessionId) ?? 0) === 0) this.closeView(sessionId);
    }, VIEW_CLOSE_GRACE_MS);
    timer.unref?.();
    this.closeTimers.set(sessionId, timer);
  }

  private cancelClose(sessionId: string): void {
    const timer = this.closeTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.closeTimers.delete(sessionId);
  }
}
