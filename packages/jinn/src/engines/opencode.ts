import { withRemoteAttachments } from "../shared/remote-attachments.js";
import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import type { InterruptibleEngine, EngineRunOpts, EngineResult, StreamDelta } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { isRemoteTarget } from "../shared/remote-target.js";
import type { RemoteExecutionConfig } from "../shared/config-types.js";
import { cleanupOpencodeSessionConfig, type OpencodeConfigHandle } from "./opencode-mcp.js";
import { OpencodeTurn } from "./opencode-turn.js";
import { RemoteKills, type RemoteRun } from "./remote-stage.js";
import {
  localOpencodeLaunch,
  remoteOpencodeLaunch,
  type OpencodeLaunchPlan,
} from "./opencode-launch.js";
import type { OpencodeMode } from "../shared/config-types.js";
import { JINN_HOME } from "../shared/paths.js";
import { type OpencodeServer, type OpencodeServerPool, type OpencodeServerSpec } from "./opencode-server.js";
import { OpencodeServerTurn } from "./opencode-server-turn.js";
import { OpencodeServerCompaction } from "./opencode-server-compaction.js";
import { isCompactCommand } from "../shared/skill-commands.js";
import { describeOpencodeLaunch } from "./opencode-protocol.js";

interface LiveProcess extends RemoteRun {
  proc: ChildProcess;
  rl: readline.Interface;
  terminationReason: string | null;
  stderr: string;
  settled: boolean;
  resolve: (res: EngineResult) => void;
  /** What the event stream has said so far. Everything about what the turn
   *  MEANS lives there; this interface is only the process around it. */
  turn: OpencodeTurn;
  hardTimeout?: NodeJS.Timeout;
  configHandle?: OpencodeConfigHandle;
}

const STDERR_MAX = 10 * 1024; // 10KB rolling window for error reporting
const TURN_TIMEOUT_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * The opencode CLI (https://opencode.ai) run headlessly.
 *
 * Invocation: `opencode run --format json --dangerously-skip-permissions \
 *   [-m provider/model] [-s <session>]`, with the prompt on stdin.
 *
 * This class owns exactly one thing: the PROCESS — spawning it, writing the
 * prompt to it, killing it, timing it out, and settling the turn exactly once.
 * What the turn MEANS lives in `opencode-turn.ts`, what it is spawned WITH lives
 * in `opencode-launch.ts`, and opencode's own wire contract in
 * `opencode-protocol.ts`. So a local turn and one carried over ssh reach this
 * file as the same thing and are run the same way.
 *
 * Resume: opencode assigns the session id (`ses_…`), reports it on every event
 * and continues it with `-s`. So unlike pi — whose session id is ours — the id
 * has to be captured from the stream and handed back as `EngineResult.sessionId`,
 * which is the same contract codex already uses.
 *
 * Remote: an employee carrying a `remoteHost` runs the same contract on another
 * machine, with an `ssh` client standing in for the local process.
 * `REMOTE_ENGINE_NAMES` in shared/models.ts names the adapters that can do that.
 */
export class OpencodeEngine implements InterruptibleEngine {
  name = "opencode" as const;
  private liveProcesses = new Map<string, LiveProcess>();
  /** Server-mode turns in flight: no process of their own, only HTTP. The slot
   *  exists from the moment the turn starts — before its server is up — so an
   *  interrupt during a server start is recorded rather than lost. */
  private serverTurns = new Map<string, ServerTurnSlot>();
  private serverTurnEndListeners: Array<(sessionId: string) => void> = [];
  private remoteKills = new RemoteKills("opencode");

  /** Live readers rather than captured values: config.yaml hot-reloads, and a
   *  `remote` block edited while the daemon runs must take effect on the next
   *  turn rather than at the next restart. Mirrors the other engines. */
  private readRemoteConfig: () => RemoteExecutionConfig | undefined;
  private readGatewayPort: () => number;
  /** `engines.opencode.mode`, read live. Absent (or anything but `server`)
   *  means `run`: the engine then behaves exactly as it did before server mode
   *  existed, which matters because it is every claude employee's fallback. */
  private readMode: () => OpencodeMode;
  private servers?: OpencodeServerPool;

  constructor(opts: {
    remote?: () => RemoteExecutionConfig | undefined;
    gatewayPort?: () => number;
    mode?: () => OpencodeMode;
    servers?: OpencodeServerPool;
  } = {}) {
    this.readRemoteConfig = opts.remote ?? (() => undefined);
    this.readGatewayPort = opts.gatewayPort ?? (() => 0);
    this.readMode = opts.mode ?? (() => "run");
    this.servers = opts.servers;
  }

  /** Told when a server-mode turn has ended (the terminal view releases
   *  composer text it held back while the turn ran). */
  onServerTurnEnd(listener: (sessionId: string) => void): void {
    this.serverTurnEndListeners.push(listener);
  }

  kill(sessionId: string, reason = "Interrupted"): void {
    const slot = this.serverTurns.get(sessionId);
    if (slot) {
      logger.info(`Interrupting opencode server turn for session ${sessionId}`);
      if (slot.turn) void slot.turn.interrupt(reason);
      else {
        slot.interrupted ??= reason;
        slot.wake?.();
      }
      return;
    }
    const live = this.liveProcesses.get(sessionId);
    if (!live) return;

    live.terminationReason = reason;
    logger.info(`Killing opencode process for session ${sessionId}`);

    try {
      live.rl.close();
    } catch {
      /* ignore */
    }

    this.terminate(live, sessionId);
  }

  killAll(): void {
    for (const sessionId of [...this.serverTurns.keys()]) {
      this.kill(sessionId, "Interrupted: gateway shutting down");
    }
    for (const sessionId of this.liveProcesses.keys()) {
      this.kill(sessionId, "Interrupted: gateway shutting down");
    }
  }

  /** Remote kills still in flight, for a shutdown to wait on. */
  pendingRemoteKills(): Promise<unknown> {
    return this.remoteKills.pending();
  }

  /** Batch engine: no warm-PTY reuse, every live process is an in-flight turn.
   *  Nothing idle to recycle on org-reload — no-op. */
  killIdle(): void {
    /* no-op */
  }

  isAlive(sessionId: string): boolean {
    const slot = this.serverTurns.get(sessionId);
    if (slot && !slot.turn?.isSettled()) return true;
    const live = this.liveProcesses.get(sessionId);
    return !!live && !live.proc.killed && live.proc.exitCode === null;
  }

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    const trackingId = opts.sessionId || `opencode-${Date.now()}`;
    const onStream = opts.onStream || null;

    // A server belongs to a Jinn session; a turn without one has nothing to reuse it.
    if (this.servers && this.readMode() === "server" && opts.sessionId) {
      return await this.runOnServer(opts, trackingId, onStream);
    }
    // Back in `run` mode with servers still warm from `server` mode: stop them,
    // and wait, or this turn's `opencode run` would write a session a server
    // still holds. (Only in `run` mode: a server-mode turn without a session id
    // must not stop every other session's server.)
    if (this.servers && this.readMode() !== "server" && this.servers.size() > 0) await this.servers.stopAll();
    return await this.runPlain(opts, trackingId, onStream);
  }

  /** One headless `opencode run` for this turn — the `run` mode, unchanged. */
  private async runPlain(
    opts: EngineRunOpts,
    trackingId: string,
    onStream: ((delta: StreamDelta) => void) | null,
  ): Promise<EngineResult> {
    if (!isRemoteTarget(opts)) {
      return await this.launch(localOpencodeLaunch(opts, trackingId), trackingId, onStream);
    }
    const plan = await remoteOpencodeLaunch(opts, trackingId, {
      remote: this.readRemoteConfig(),
      gatewayPort: this.readGatewayPort(),
    });
    return await this.launch(plan, trackingId, onStream);
  }

  /**
   * The turn, sent to the session's opencode server over its HTTP API (see
   * `opencode-server-turn.ts` for why not `run --attach`). The server's events
   * are read by the same `OpencodeTurn` parser as `run` mode's stdout. An
   * interrupt aborts the turn on the server and waits for it to go idle.
   *
   * A server that will not start is not a reason to fail the turn: it runs as
   * a plain `opencode run` instead, with a warning, after making sure no server
   * is left holding the session.
   */
  private async runOnServer(
    opts: EngineRunOpts,
    trackingId: string,
    onStream: ((delta: StreamDelta) => void) | null,
  ): Promise<EngineResult> {
    const slot: ServerTurnSlot = {};
    this.serverTurns.set(trackingId, slot);
    try {
      const server = await this.serverForTurn(slot, opts, trackingId);
      if (!server) return interruptedBeforePost(opts, slot.interrupted!);
      if (server instanceof Error) return await this.fallBackToRun(opts, trackingId, onStream, server);
      return await this.runServerTurn(server, slot, opts, trackingId, onStream);
    } finally {
      if (this.serverTurns.get(trackingId) === slot) this.serverTurns.delete(trackingId);
      for (const listener of this.serverTurnEndListeners) listener(trackingId);
    }
  }

  /**
   * The session's server for this turn, the error it would not start with, or
   * undefined when the turn was interrupted before it had one. A start can take
   * as long as the instance's bootstrap (up to bootstrapTimeoutMs), which an
   * interrupt must not wait out: once the slot records one, this
   * returns without a hold. The start carries on so the next turn finds the
   * server warm, and the hold it takes is dropped once it exists; a start that
   * fails has already stopped its own server.
   */
  private async serverForTurn(slot: ServerTurnSlot, opts: EngineRunOpts, trackingId: string): Promise<OpencodeServer | Error | undefined> {
    const servers = this.servers!;
    const interrupted = new Promise<undefined>((resolve) => { slot.wake = () => resolve(undefined); });
    const acquiring = servers.acquire(trackingId, serverSpecFor(opts)).catch((err: unknown) => err as Error);
    const server = await Promise.race([acquiring, interrupted]);
    if (!slot.interrupted) return server;
    void acquiring.then((started) => { if (!(started instanceof Error)) servers.release(trackingId); });
    return undefined;
  }

  /** No server for this turn: run it as a plain `opencode run`, once nothing
   *  is left holding the session. */
  private async fallBackToRun(
    opts: EngineRunOpts,
    trackingId: string,
    onStream: ((delta: StreamDelta) => void) | null,
    why: Error,
  ): Promise<EngineResult> {
    logger.warn(`opencode server mode: no server for session ${trackingId} (${why.message}); running this turn as a plain opencode run`);
    await this.servers!.stop(trackingId);
    // Still this turn's slot until the plain run's process exists to be killed.
    const interrupted = this.serverTurns.get(trackingId)?.interrupted;
    if (interrupted) return interruptedBeforePost(opts, interrupted);
    this.serverTurns.delete(trackingId);
    return await this.runPlain(opts, trackingId, onStream);
  }

  /** One turn on a server this session already holds; releases the hold. */
  private async runServerTurn(
    server: OpencodeServer,
    slot: ServerTurnSlot,
    opts: EngineRunOpts,
    trackingId: string,
    onStream: ((delta: StreamDelta) => void) | null,
  ): Promise<EngineResult> {
    const servers = this.servers!;
    // `/compact` is opencode's own compaction, not a prompt (see
    // opencode-server-compaction.ts) — Jinn's self-compaction queues it, and an
    // operator may type it.
    if (isCompactCommand(opts.prompt)) return await this.runServerCompaction(server, slot, opts, trackingId);
    let drifted = false;
    // A remote server's session sees the gateway's files through its staged
    // home, so the turn names them there rather than by their gateway paths.
    const turnOpts = server.remote ? withRemoteAttachments(opts, server.remote.staging.sessionHome, trackingId) : opts;
    const turn = new OpencodeServerTurn(server, turnOpts, onStream, {
      abort: (target) => servers.abortTurn(trackingId, target),
      onSessionId: (id) => servers.noteEngineSession(trackingId, id),
      onProtocolDrift: (reason) => {
        drifted = true;
        servers.markUnsupported(server.hostKey, `opencode ${server.hostKey} server API drift: ${reason}`);
      },
    });
    slot.turn = turn;
    logger.info(
      `opencode engine starting on the session's server (${server.hostKey} ${server.apiUrl}): ${describeOpencodeLaunch(opts)} `
      + `(resume: ${opts.resumeSessionId || "none"})`,
    );
    try {
      const result = await turn.run();
      if (result.error) logger.error(result.error);
      return result;
    } finally {
      servers.release(trackingId);
      // Off server mode for this host: the next turn resumes the same opencode
      // session with a plain `run`, which must not find a server still holding it.
      if (drifted) await servers.stop(trackingId);
    }
  }

  /** A `/compact` turn on the session's server; releases the hold. */
  private async runServerCompaction(
    server: OpencodeServer,
    slot: ServerTurnSlot,
    opts: EngineRunOpts,
    trackingId: string,
  ): Promise<EngineResult> {
    const compaction = new OpencodeServerCompaction(server, opts);
    slot.turn = compaction;
    logger.info(`opencode engine compacting session ${opts.resumeSessionId || "(none yet)"} on its server (${server.hostKey})`);
    try {
      const result = await compaction.run();
      if (result.error) logger.error(result.error);
      return result;
    } finally {
      this.servers!.release(trackingId);
    }
  }

  /** Spawn one opencode run — local or over ssh — and resolve when it settles.
   *  Everything below this line is transport-agnostic: it reads the same JSON
   *  event stream either way. */
  private launch(
    plan: OpencodeLaunchPlan,
    trackingId: string,
    onStream: ((delta: StreamDelta) => void) | null,
  ): Promise<EngineResult> {
    return new Promise((resolve, reject) => {
      const proc = spawn(plan.bin, plan.args, {
        cwd: plan.cwd,
        env: plan.env,
        stdio: ["pipe", "pipe", "pipe"],
        // Own the whole group so a kill reaches every child. For a remote run
        // the group is only the local ssh client, and closing its channel
        // signals nothing on the other side (no tty, so no hangup) — the
        // remote opencode is killed by name instead; see `terminate`.
        detached: process.platform !== "win32",
      });

      this.writePrompt(proc, trackingId, plan.prompt);
      const live = this.track(proc, plan, trackingId, resolve);
      this.attachStreams(proc, live, trackingId, onStream, reject);
    });
  }

  /** Register the run so `kill`, `isAlive` and the timeout can reach it. */
  private track(
    proc: ChildProcess,
    plan: OpencodeLaunchPlan,
    trackingId: string,
    resolve: (res: EngineResult) => void,
  ): LiveProcess {
    const live: LiveProcess = {
      proc,
      rl: readline.createInterface({ input: proc.stdout!, terminal: false }),
      terminationReason: null,
      stderr: "",
      settled: false,
      resolve,
      turn: new OpencodeTurn(plan.sessionIdOut),
      ...(plan.configHandle ? { configHandle: plan.configHandle } : {}),
      ...(plan.remote ? { remote: plan.remote } : {}),
    };
    this.liveProcesses.set(trackingId, live);
    this.armTurnTimeout(trackingId, live);
    return live;
  }

  private attachStreams(
    proc: ChildProcess,
    live: LiveProcess,
    trackingId: string,
    onStream: ((delta: StreamDelta) => void) | null,
    reject: (err: Error) => void,
  ): void {
    live.rl.on("line", (line) => live.turn.readLine(line, onStream));

    proc.stderr?.on("data", (d: Buffer) => {
      const chunk = d.toString();
      live.stderr = (live.stderr + chunk).slice(-STDERR_MAX);
      for (const l of chunk.trim().split("\n").filter(Boolean)) logger.debug(`[opencode stderr] ${l}`);
    });

    proc.on("close", (code) => this.settle(trackingId, code));

    proc.on("error", (err) => {
      const l = this.liveProcesses.get(trackingId);
      if (!l || l.settled) return;
      l.settled = true;
      this.clearTimers(l);
      cleanupOpencodeSessionConfig(l.configHandle);
      this.liveProcesses.delete(trackingId);
      reject(new Error(`Failed to spawn opencode CLI: ${err.message}`));
    });
  }

  private writePrompt(proc: ChildProcess, trackingId: string, prompt: string): void {
    if (!proc.stdin) {
      logger.error(`opencode engine spawned without a stdin pipe for session ${trackingId}; the prompt cannot be delivered`);
      return;
    }
    // A prompt written to an opencode that has already died raises EPIPE here;
    // the close handler reports the real failure, so surface it and move on.
    proc.stdin.on("error", (err: Error) => {
      logger.warn(`opencode engine could not write the prompt to stdin for session ${trackingId}: ${err.message}`);
    });
    proc.stdin.write(prompt);
    proc.stdin.end();
  }

  private armTurnTimeout(trackingId: string, live: LiveProcess): void {
    live.hardTimeout = setTimeout(() => {
      const l = this.liveProcesses.get(trackingId);
      if (!l || l.settled) return;
      l.terminationReason = "opencode turn timed out";
      logger.warn(`opencode turn timed out for session ${trackingId}; terminating process`);
      this.terminate(l, trackingId);
    }, TURN_TIMEOUT_MS);
    live.hardTimeout.unref?.();
  }

  /** End the run — for a remote run the opencode on the other host FIRST, and
   *  the local ssh client only once that has answered; see `RemoteKills`. */
  private terminate(live: LiveProcess, trackingId: string): void {
    this.remoteKills.terminate(live, trackingId, () => this.signalLocal(live));
  }

  private signalLocal(live: LiveProcess): void {
    this.signalProcess(live.proc, "SIGTERM");
    setTimeout(() => {
      if (live.proc.exitCode === null) this.signalProcess(live.proc, "SIGKILL");
    }, 2000).unref?.();
  }

  /** Resolve a live run exactly once, mirroring the other batch engines. */
  private settle(trackingId: string, code: number | null): void {
    const live = this.liveProcesses.get(trackingId);
    if (!live || live.settled) return;
    live.settled = true;
    this.clearTimers(live);
    cleanupOpencodeSessionConfig(live.configHandle);

    try {
      live.rl.close();
    } catch {
      /* ignore */
    }
    // `close` should mean the child is gone, but keep this defensive guard for
    // abnormal streams where settle() runs before exit accounting lands.
    if (live.proc.exitCode === null) {
      try {
        live.proc.kill();
      } catch {
        /* ignore */
      }
    }

    const finish = () => {
      this.liveProcesses.delete(trackingId);
      const result = live.turn.result({ code, terminationReason: live.terminationReason, stderr: live.stderr });
      if (result.error) logger.error(result.error);
      live.resolve(result);
    };
    // A remote run settles only once the opencode over there is known to be
    // gone: the next turn starts on this settle, and would otherwise start
    // beside it. A local run has nothing to wait for.
    void this.remoteKills.beforeSettle(live, trackingId, code).finally(finish);
  }

  private clearTimers(live: LiveProcess): void {
    if (live.hardTimeout) clearTimeout(live.hardTimeout);
    live.hardTimeout = undefined;
  }

  private signalProcess(proc: ChildProcess, signal: NodeJS.Signals): void {
    if (proc.exitCode !== null) return;
    try {
      if (process.platform !== "win32" && proc.pid) {
        process.kill(-proc.pid, signal);
      } else {
        proc.kill(signal);
      }
    } catch (err) {
      logger.debug(`Failed to send ${signal} to opencode process: ${err instanceof Error ? err.message : err}`);
    }
  }
}

/** A server-mode turn from its start: the interrupt that arrived before it had
 *  a server, and the turn once it has one. */
interface ServerTurnSlot {
  interrupted?: string;
  /** Wakes a turn still waiting for its server when it is interrupted. */
  wake?: () => void;
  turn?: Pick<OpencodeServerTurn, "run" | "interrupt" | "isSettled">;
}

/** The result of a turn interrupted before its prompt reached a server: nothing
 *  ran, so nothing is lost, and the session to resume is the one it was given. */
function interruptedBeforePost(opts: EngineRunOpts, reason: string): EngineResult {
  return { sessionId: opts.resumeSessionId || "", result: "", error: reason };
}

/** What a turn needs its server started with. */
function serverSpecFor(opts: EngineRunOpts): OpencodeServerSpec {
  return {
    cwd: opts.cwd || JINN_HOME,
    ...(opts.bin ? { bin: opts.bin } : {}),
    ...(opts.resolvedMcp ? { resolvedMcp: opts.resolvedMcp } : {}),
    ...(opts.remoteHost ? { remoteHost: opts.remoteHost } : {}),
    ...(opts.remoteUser ? { remoteUser: opts.remoteUser } : {}),
    ...(opts.remoteCwd ? { remoteCwd: opts.remoteCwd } : {}),
  };
}
