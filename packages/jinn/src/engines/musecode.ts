import type { EngineResult, EngineRunOpts, InterruptibleEngine } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { resolveBin } from "../shared/resolve-bin.js";
import { buildEngineChildEnv } from "../shared/child-env.js";
import { lostConversationFailure } from "../shared/process-start.js";
import { employeeSessionEnv } from "../sessions/employee-env.js";
import { MspClient, MspClosedError, uuidv7 } from "./musecode-msp.js";
import { MspProcess } from "./musecode-process.js";
import {
  buildMuseServeArgs,
  buildMusecodePrompt,
  describeMusecodeLaunch,
  museReasoningEffort,
} from "./musecode-protocol.js";
import { buildMuseSessionConfig } from "./musecode-mcp.js";
import { FIRST_EVENT_TIMEOUT_MS, silentTurnResult, watchForSilence } from "./musecode-watchdog.js";
import { loadMuseAttachments } from "./musecode-attachments.js";
import { answerMuseServerRequest } from "./musecode-approvals.js";
import { MuseTurn, type MuseModelCost, type MuseUsageSnapshot } from "./musecode-turn.js";
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

export interface MusecodeEngineOptions {
  /** Told of every subscription-usage snapshot a turn's host reports. */
  onUsage?: (usage: MuseUsageSnapshot) => void;
  /** The per-million-token rates of a model, once a catalog knows them. Without one a turn carries no cost. */
  modelCost?: (modelId: string | undefined) => MuseModelCost | undefined;
  /**
   * Called before a turn on a session that already has a conversation, to let go
   * of a terminal view that holds it: Muse refuses a second owner, so a turn
   * cannot resume a session its terminal has open.
   */
  releaseView?: (sessionId: string) => Promise<void>;
  /** How long an accepted turn may go unheard before it is given up on. Defaults to {@link FIRST_EVENT_TIMEOUT_MS}. */
  firstEventTimeoutMs?: number;
}

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
 * Local only: Muse is not in `REMOTE_ENGINE_NAMES`, so a turn is never carried
 * to another machine.
 */
export class MusecodeEngine implements InterruptibleEngine {
  name = "musecode" as const;
  private live = new Map<string, LiveTurn>();

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
        await live.proc?.shutdown();
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
    const proc = this.spawnHost(opts, trackingId, live);
    const client = proc.client;
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
    const started = await this.startTurn(client, turn, opts, live);
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

  private spawnHost(opts: EngineRunOpts, trackingId: string, live: LiveTurn): MspProcess {
    const bin = resolveBin("muse", opts.bin);
    const env = buildEngineChildEnv(process.env, { scrubClaudeCode: true, scrubCodex: true });
    env.JINN_SESSION_ID = trackingId;
    Object.assign(env, employeeSessionEnv(trackingId));
    logger.info(`Muse Code engine starting: ${bin} ${describeMusecodeLaunch(opts)} (resume: ${opts.resumeSessionId || "none"})`);
    const proc = new MspProcess({ bin, args: buildMuseServeArgs(opts), cwd: opts.cwd, env });
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
      clientInfo: { name: "marid", version: packageVersion() },
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
  private async startTurn(client: MspClient, turn: MuseTurn, opts: EngineRunOpts, live: LiveTurn): Promise<EngineResult | undefined> {
    const sessionId = live.sessionId!;
    const { images, remaining } = loadMuseAttachments(opts.attachments);
    const text = buildMusecodePrompt({ ...opts, attachments: remaining });
    const effort = museReasoningEffort(opts.effortLevel);
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
