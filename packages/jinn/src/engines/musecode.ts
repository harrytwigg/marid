import type { EngineResult, EngineRunOpts, InterruptibleEngine } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { NAMES } from "../shared/codename.js";
import { resolveBin } from "../shared/resolve-bin.js";
import { buildEngineChildEnv } from "../shared/child-env.js";
import { lostConversationFailure } from "../shared/process-start.js";
import { employeeSessionEnv } from "../sessions/employee-env.js";
import { JINN_HOME } from "../shared/paths.js";
import { envNamesFor } from "../shared/codename-env.js";
import { withRemoteAttachments } from "../shared/remote-attachments.js";
import { assertRemoteTarget, isRemoteTarget } from "../shared/remote-target.js";
import {
  buildSshSpawnArgs,
  ensureRemoteReady,
  prepareRemoteSession,
  reapStaleRemoteEngine,
  remoteEnginePidFile,
  remoteNodeDir,
  remoteSessionBinDir,
  requireRemoteEngineBin,
  RemoteKills,
  type RemoteEngineHandle,
} from "./remote-stage.js";
import { MspClient, MspClosedError, uuidv7 } from "./musecode-msp.js";
import { MspProcess } from "./musecode-process.js";
import {
  buildMuseServeArgs,
  buildMusecodePrompt,
  describeMusecodeLaunch,
  museTurnEffort,
} from "./musecode-protocol.js";
import type { MusecodeEngineOptions } from "./musecode-options.js";
import { buildMuseSessionConfig } from "./musecode-mcp.js";
import { FIRST_EVENT_TIMEOUT_MS, silentTurnResult, watchForSilence } from "./musecode-watchdog.js";
import { loadMuseAttachments } from "./musecode-attachments.js";
import { answerMuseServerRequest } from "./musecode-approvals.js";
import { MuseTurn } from "./musecode-turn.js";
import { CONVERSATION_KEPT } from "./musecode-turn-text.js";
import {
  askTurnToStop,
  describeMspFailure,
  hostLost,
  hostNeverStarted,
  interruptedResult,
  isLostSession,
  openedSession,
  packageVersion,
  signalHost,
  waitForEnd,
  type LiveTurn,
  type OpenedSession,
} from "./musecode-run.js";

const TURN_TIMEOUT_MS = 14 * 24 * 60 * 60 * 1000;

/** A turn's host process, and the turn's options as that host sees them. */
interface MuseHost {
  proc: MspProcess;
  opts: EngineRunOpts;
  /** Attachment paths (the gateway's) as the host names them in the prompt. */
  attachmentPaths: (files: string[]) => string[];
}

export type { MusecodeEngineOptions } from "./musecode-options.js";

/**
 * Muse Code (https://dev.meta.ai), driven over its own session protocol.
 *
 * A turn spawns `muse serve`, speaks MSP to it over stdio (initialize, start or
 * resume the session, one `turn/start`), settles on `turn/completed` and then
 * closes the host's stdin and waits for it to leave. There is no pool of hosts:
 * a turn owns its process, so there is nothing to recycle, nothing to leak
 * between sessions and nothing to reconcile on a restart. The conversation lives
 * in Muse's own session store, and its session id is the resume id.
 *
 * This class owns the PROCESS and the requests. What the turn means is
 * `musecode-turn.ts`, the argv and prompt are `musecode-protocol.ts`, the MCP
 * servers are `musecode-mcp.ts`, and the transport is `musecode-msp.ts`.
 *
 * Remote: an employee carrying a `remoteHost` runs the same host on that
 * machine, with an `ssh -T` client standing in for the local process. MSP is
 * newline-delimited JSON on stdin and stdout, which ssh carries verbatim, so
 * nothing above the process changes (see {@link spawnRemoteHost}).
 */
export class MusecodeEngine implements InterruptibleEngine {
  name = "musecode" as const;
  private live = new Map<string, LiveTurn>();
  private remoteKills = new RemoteKills("musecode");

  /**
   * Variables the REMOTE login environment must not carry into `muse`: the
   * markers that tell a nested CLI it runs inside another agent, which the local
   * host has scrubbed by `buildEngineChildEnv`. Provider keys are left alone, as
   * for pi and opencode: `META_API_KEY` is one way Muse signs in at all.
   */
  private static readonly REMOTE_ENV_DENY = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", ...envNamesFor(["HOME_IDENTITY", "TAKE_PORT"])];

  constructor(private readonly options: MusecodeEngineOptions = {}) {}

  kill(sessionId: string, reason = "Interrupted"): void {
    const live = this.live.get(sessionId);
    if (!live || live.settled) return;
    live.reason ??= reason;
    logger.info(`Interrupting Muse Code turn for session ${sessionId}`);
    void this.interrupt(live);
  }

  killAll(): void {
    for (const sessionId of [...this.live.keys()]) this.kill(sessionId, "Interrupted: gateway shutting down");
  }

  /** Remote kills still in flight, for a shutdown to wait on. */
  pendingRemoteKills(): Promise<unknown> {
    return this.remoteKills.pending();
  }

  /** Batch engine: a host lives only as long as its turn, so there is nothing idle to recycle. */
  killIdle(): void {
    /* no-op */
  }

  /** Whether a turn is in flight on the session: from the moment `run` is entered until its host process is gone. */
  hasLiveRun(sessionId: string): boolean {
    return this.live.has(sessionId);
  }

  isAlive(sessionId: string): boolean {
    const live = this.live.get(sessionId);
    return !!live && !live.settled && !!live.proc && !live.proc.hasExited;
  }

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    const trackingId = opts.sessionId || `musecode-${Date.now()}`;
    const live: LiveTurn = { reason: null, proc: null, turn: null, sessionId: null, turnId: null, settled: false };
    this.live.set(trackingId, live);
    const timeout = setTimeout(() => this.kill(trackingId, "Muse Code turn timed out"), TURN_TIMEOUT_MS);
    timeout.unref?.();
    try {
      return await this.runTurn(opts, trackingId, live);
    } finally {
      clearTimeout(timeout);
      live.settled = true;
      // Live until its host is gone: a terminal opened before then would meet a session the host still holds.
      try {
        const exit = await live.proc?.shutdown();
        // A remote host's ssh client can close with the host still running over there (a dropped connection, or our own signal racing the pid file).
        if (exit) await this.remoteKills.beforeSettle(live, trackingId, exit.code);
      } finally {
        if (this.live.get(trackingId) === live) this.live.delete(trackingId);
      }
    }
  }

  /** Let go of a terminal that holds the conversation about to be resumed. A failure to is logged; the turn goes on. */
  private async closeView(opts: EngineRunOpts): Promise<void> {
    if (!opts.resumeSessionId || !opts.sessionId) return;
    await this.options.releaseView?.(opts.sessionId).catch((err) => {
      logger.warn(`Muse Code could not close the terminal view of ${opts.sessionId}: ${err instanceof Error ? err.message : err}`);
    });
  }

  private async runTurn(opts: EngineRunOpts, trackingId: string, live: LiveTurn): Promise<EngineResult> {
    await this.closeView(opts);
    if (live.reason) return interruptedResult(opts, live.reason);
    const host = await this.startHost(opts, trackingId, live);
    // Staging a remote host takes a few round trips; an interrupt in that time had no host to reach.
    if (live.reason) return interruptedResult(opts, live.reason);
    const proc = host.proc;
    const client = proc.client;
    // From here on the turn sees the host's own world: its working directory and MCP set.
    opts = host.opts;
    let session: OpenedSession;
    try {
      const config = await this.negotiate(client, opts);
      session = await this.openSession(client, opts, config);
      live.sessionId = session.sessionId;
    } catch (err) {
      return await this.openFailure(err, proc, opts, live);
    }
    if (live.reason) return interruptedResult(opts, live.reason, session.sessionId);

    const turn = new MuseTurn(session.sessionId, {
      onStream: opts.onStream ?? null,
      onUsage: (usage) => this.options.onUsage?.(usage),
    });
    live.turn = turn;
    if (session.projectionUnavailable) opts.onStream?.({ type: "status", content: "Muse Code could not read this conversation's history (projectionUnavailable); the turn may not start" });
    await this.syncModel(client, session, opts);
    const started = await this.startTurn(client, turn, opts, live, host.attachmentPaths);
    if (started) return started;
    return await this.awaitTurn(turn, session, live, opts);
  }

  /** Wait for an accepted turn to end, or for the host to say nothing about it for the whole bound. */
  private async awaitTurn(turn: MuseTurn, session: OpenedSession, live: LiveTurn, opts: EngineRunOpts): Promise<EngineResult> {
    const proc = live.proc!;
    const watch = watchForSilence(turn, this.options.firstEventTimeoutMs ?? FIRST_EVENT_TIMEOUT_MS);
    const silent = await Promise.race([waitForEnd(turn, proc.client).then(() => false), watch.silent.then(() => true)]);
    watch.cancel();
    if (silent && !turn.isCompleted && !live.reason) {
      logger.error(`Muse Code accepted a turn on ${session.sessionId} and sent nothing about it; giving up on it`);
      return silentTurnResult(session);
    }
    return this.settle(turn, proc, live, opts);
  }

  /** What the finished (or abandoned) turn became. */
  private async settle(turn: MuseTurn, proc: MspProcess, live: LiveTurn, opts: EngineRunOpts): Promise<EngineResult> {
    if (!turn.isCompleted && !live.reason) return await hostLost(proc, live, opts);
    const rates = this.options.modelCost?.(opts.model);
    const result = turn.result({ terminationReason: live.reason, ...(rates ? { costRates: rates } : {}) });
    if (result.error && !result.error.startsWith("Interrupted")) logger.error(result.error);
    return result;
  }

  /** The turn's host: `muse serve` here, or on the session's remote host over ssh. */
  private async startHost(opts: EngineRunOpts, trackingId: string, live: LiveTurn): Promise<MuseHost> {
    if (isRemoteTarget(opts)) return await this.spawnRemoteHost(opts, trackingId, live);
    return { proc: this.spawnHost(opts, trackingId, live), opts, attachmentPaths: (files) => files };
  }

  /**
   * Start the turn's host on the session's remote host: `muse serve` with the
   * same argv, its stdio carried by `ssh -T`.
   *
   * No tty, because one would fold Muse's stderr into the JSON on stdout. That
   * makes it a batch engine as pi and opencode are: closing the channel signals
   * nothing over there, so the host's pid is recorded and an interrupt or a
   * timeout ends it on that machine first (`RemoteKills`). Closing stdin, which
   * is how a turn's host is normally let go, reaches it as EOF.
   *
   * What changes for the turn is returned in `opts`: the workspace is the
   * remote working directory, and the MCP set is the one re-pointed at that
   * host's install and the reverse tunnel. It still travels in `session/start`
   * over stdin, so the session's capability is never on a command line.
   */
  private async spawnRemoteHost(opts: EngineRunOpts, trackingId: string, live: LiveTurn): Promise<MuseHost> {
    const { staging, facts, handle, gatewayPort } = await this.stageRemoteHost(opts, trackingId);
    const args = buildSshSpawnArgs({
      destination: staging.destination,
      tunnelPort: staging.tunnelPort,
      gatewayPort,
      remoteCwd: opts.remoteCwd!,
      remoteEnv: { JINN_HOME: staging.sessionHome, JINN_SESSION_ID: trackingId },
      // The gateway URL, its bearer and the employee's session identity, from a 0600 file rather than a command line.
      envFile: staging.envFilePath,
      unsetRemoteEnv: MusecodeEngine.REMOTE_ENV_DENY,
      // The jinn MCP server is a node script, and the instance's own bin/ carries `mem`.
      pathPrepend: [remoteNodeDir(facts), remoteSessionBinDir(staging.sessionHome)],
      bin: handle.bin,
      args: buildMuseServeArgs(opts),
      allocateTty: false,
      pidFile: handle.pidFile,
    });
    logger.info(
      `Muse Code engine starting REMOTE on ${staging.destination}:${opts.remoteCwd} — ${describeMusecodeLaunch(opts)} `
      + `(resume: ${opts.resumeSessionId || "none"}, tunnel: ${staging.tunnelPort}→${gatewayPort}, jinn tools: ${staging.resolvedMcp ? "on" : "off"})`,
    );
    live.remote = handle;
    const env = buildEngineChildEnv(process.env, { scrubClaudeCode: true, scrubCodex: true });
    // The ssh client's own cwd is irrelevant: the remote command opens with a `cd` into remoteCwd.
    const proc = this.attachHost(new MspProcess({
      bin: resolveBin("ssh"),
      args,
      cwd: JINN_HOME,
      env,
      signalVia: (signalLocal) => this.remoteKills.terminate(live, trackingId, signalLocal),
    }), live);
    const { resolvedMcp: _local, ...rest } = opts;
    return {
      proc,
      opts: { ...rest, cwd: opts.remoteCwd!, ...(staging.resolvedMcp ? { resolvedMcp: staging.resolvedMcp } : {}) },
      // Attachments named in the prompt as the remote session's staged home sees them; images go inline and are read here.
      attachmentPaths: (files) => withRemoteAttachments({ attachments: files }, staging.sessionHome, trackingId).attachments ?? files,
    };
  }

  /** Make the remote host ready for the turn: readiness, the session's stage, and no host left over from an earlier turn. */
  private async stageRemoteHost(opts: EngineRunOpts, trackingId: string) {
    const remote = this.options.remote?.();
    assertRemoteTarget(opts, remote);
    const gatewayPort = this.options.gatewayPort?.() ?? 0;
    // Without a real gateway port the reverse forward would be built as `-R <n>:127.0.0.1:0`, and every jinn tool call would answer into nothing.
    if (!gatewayPort) throw new Error("remote spawn needs the gateway's port for the reverse tunnel, and none was provided");
    const readiness = await ensureRemoteReady(opts, remote, { engine: "musecode", allowWake: false });
    if (!readiness.ready) throw new Error(`remote host not ready: ${readiness.reason}`);
    const facts = readiness.facts;
    const staging = await prepareRemoteSession({
      target: opts,
      remote: remote!,
      facts,
      engine: "musecode",
      jinnSessionId: trackingId,
      gatewayPort,
      ...(opts.resolvedMcp ? { resolvedMcp: opts.resolvedMcp } : {}),
    });
    const handle: RemoteEngineHandle = {
      destination: staging.destination,
      pidFile: remoteEnginePidFile(staging.sessionHome),
      bin: requireRemoteEngineBin(staging.destination, facts, "musecode"),
    };
    await reapStaleRemoteEngine(handle, "musecode");
    return { staging, facts, handle, gatewayPort };
  }

  private spawnHost(opts: EngineRunOpts, trackingId: string, live: LiveTurn): MspProcess {
    const bin = resolveBin("muse", opts.bin);
    const env = buildEngineChildEnv(process.env, { scrubClaudeCode: true, scrubCodex: true });
    env.JINN_SESSION_ID = trackingId;
    Object.assign(env, employeeSessionEnv(trackingId));
    logger.info(`Muse Code engine starting: ${bin} ${describeMusecodeLaunch(opts)} (resume: ${opts.resumeSessionId || "none"})`);
    return this.attachHost(new MspProcess({ bin, args: buildMuseServeArgs(opts), cwd: opts.cwd, env }), live);
  }

  /** Make `proc` the turn's host: what it says reaches the turn, and what it asks is answered. */
  private attachHost(proc: MspProcess, live: LiveTurn): MspProcess {
    live.proc = proc;
    proc.client.onNotification((method, params) => live.turn?.read(method, params));
    proc.client.onServerRequest((method, params) => answerMuseServerRequest(proc.client, method, params));
    return proc;
  }

  /**
   * `initialize`. MCP servers can only be handed over per session if the host
   * grants the `sessionMcp` capability, which it does on request, so it is asked
   * for exactly when the session has servers. Returns the `config` for
   * `session/start` and `session/resume`, or undefined when there is none to send.
   */
  private async negotiate(client: MspClient, opts: EngineRunOpts): Promise<ReturnType<typeof buildMuseSessionConfig>> {
    const config = buildMuseSessionConfig(opts.resolvedMcp);
    const init = await client.initialize({
      clientInfo: { name: NAMES.codename, version: packageVersion() },
      userInputDialogs: false,
      ...(config ? { requestedCapabilities: ["sessionMcp"] } : {}),
    });
    if (!config || (Array.isArray(init.grantedCapabilities) && init.grantedCapabilities.includes("sessionMcp"))) return config;
    logger.warn("Muse Code did not grant session MCP; this turn runs without the company tools");
    opts.onStream?.({ type: "status", content: "Muse Code did not grant session MCP; running without the company tools" });
    return undefined;
  }

  /** `session/start`, or `session/resume` of the conversation the session already has. */
  private async openSession(client: MspClient, opts: EngineRunOpts, config: ReturnType<typeof buildMuseSessionConfig>): Promise<OpenedSession> {
    if (opts.resumeSessionId) {
      const result = await client.request("session/resume", {
        commandId: uuidv7(),
        sessionId: opts.resumeSessionId,
        history: "auto",
        excludeItems: true,
        ...(config ? { config } : {}),
      });
      return openedSession(result, opts.resumeSessionId);
    }
    const result = await client.request("session/start", {
      commandId: uuidv7(),
      workspaceRoot: opts.cwd,
      approvalMode: "allowAll",
      ...(opts.model ? { modelId: opts.model } : {}),
      ...(config ? { config } : {}),
    });
    return openedSession(result);
  }

  /** A resumed conversation keeps the model it last ran; the employee's configured one wins. */
  private async syncModel(client: MspClient, session: OpenedSession, opts: EngineRunOpts): Promise<void> {
    if (!opts.resumeSessionId || !opts.model || session.modelId === opts.model) return;
    try {
      await client.request("session/setModel", { commandId: uuidv7(), sessionId: session.sessionId, model: { modelId: opts.model } });
    } catch (err) {
      // Carrying on with the conversation's own model beats failing a turn over a picker.
      logger.warn(`Muse Code could not switch session ${session.sessionId} to ${opts.model}: ${err instanceof Error ? err.message : err}`);
      opts.onStream?.({ type: "status", content: `Muse Code could not switch to ${opts.model}; continuing on ${session.modelId ?? "its current model"}` });
    }
  }

  /** `turn/start`. Returns a result only when the turn could not be started. */
  private async startTurn(
    client: MspClient, turn: MuseTurn, opts: EngineRunOpts, live: LiveTurn, attachmentPaths: MuseHost["attachmentPaths"],
  ): Promise<EngineResult | undefined> {
    const sessionId = live.sessionId!;
    const { images, remaining } = loadMuseAttachments(opts.attachments);
    const text = buildMusecodePrompt({ ...opts, attachments: attachmentPaths(remaining) });
    const effort = museTurnEffort(opts, this.options.effortLevels?.());
    try {
      const ack = await client.request("turn/start", {
        commandId: uuidv7(),
        sessionId,
        input: [{ type: "text", text }, ...images],
        ...(effort ? { reasoningEffort: effort } : {}),
      });
      const turnId = typeof ack.turnId === "string" ? ack.turnId : null;
      if (turnId) {
        turn.setTurnId(turnId);
        live.turnId = turnId;
      }
      if (ack.disposition !== "started") {
        return { sessionId, result: "", error: `Muse Code did not start the turn (${String(ack.disposition ?? "no disposition")})`, ...CONVERSATION_KEPT };
      }
      return undefined;
    } catch (err) {
      if (live.reason) return interruptedResult(opts, live.reason, sessionId);
      const error = describeMspFailure(err);
      logger.error(`Muse Code turn/start failed: ${error}`);
      return { sessionId, result: "", error, ...CONVERSATION_KEPT };
    }
  }

  /** Why the session could not be opened, as the result the turn runner understands. */
  private async openFailure(err: unknown, proc: MspProcess, opts: EngineRunOpts, live: LiveTurn): Promise<EngineResult> {
    const resume = opts.resumeSessionId;
    if (live.reason) return interruptedResult(opts, live.reason);
    if (proc.failedToSpawn) throw new Error(`Failed to spawn Muse Code CLI: ${proc.failedToSpawn.message}`);
    // The conversation is gone: no work, no cost, so the runner clears the id and starts a fresh one.
    if (resume && isLostSession(err)) {
      return { sessionId: resume, result: "", error: lostConversationFailure("musecode", resume) };
    }
    if (err instanceof MspClosedError) return await hostNeverStarted(proc, resume);
    const error = describeMspFailure(err);
    logger.error(`Muse Code could not open its session: ${error}`);
    // A session that was to be resumed is known to exist; only a failure to resume it is not "no work".
    return { sessionId: resume ?? "", result: "", error, ...(resume ? CONVERSATION_KEPT : {}) };
  }

  /** Ask the turn to stop; if it has not within a few seconds, signal its host. */
  private async interrupt(live: LiveTurn): Promise<void> {
    const { proc, turn } = live;
    if (!proc) return;
    if (turn && live.sessionId && !turn.isCompleted) await askTurnToStop(proc, turn, live);
    if (!turn?.isCompleted) await signalHost(proc, live);
  }
}
