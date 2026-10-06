import fs from "node:fs";
import type {
  Connector,
  Employee,
  Engine,
  IncomingMessage,
  JinnConfig,
  Session,
  Target,
} from "../shared/types.js";
import { isInterruptibleEngine } from "../shared/types.js";
import { newSessionEngineSelection } from "./new-session-engine.js";
import { removeCodexSessionHome } from "../engines/codex.js";
import { ptySnapshotStore } from "../engines/pty-snapshot.js";
import {
  createSession,
  deleteSession,
  getSession,
  getSessionBySessionKey,
  insertMessage,
  updateSession,
  beginSessionAttempt,
} from "./registry.js";
import { SessionQueue } from "./queue.js";
import { logger } from "../shared/logger.js";
import { AUTO_COMPACT_BUDGET_HOLD_KEY } from "../shared/auto-compact-config.js";
import { loadJobs } from "../cron/jobs.js";
import { setCronJobEnabled, triggerCronJob } from "../cron/scheduler.js";
import { reconcileWorkItem } from "../work-items/reconcile.js";
// Re-exported because the gateway API reverts an expired override on session reads.
import { maybeRevertEngineOverride } from "./engine-override.js";
export { maybeRevertEngineOverride };
import { runTurn } from "./turn/runner.js";
import { resolveTurnHierarchy } from "./turn/preflight.js";
import { createConnectorTurnSurface } from "./turn/connector-surface.js";
import type { GatewayEmit } from "../shared/gateway-events.js";

export interface RouteOptions {
  employee?: Employee;
  engine?: string;
  model?: string;
  effortLevel?: string;
  title?: string;
}

export function mergeTransportMeta(
  existing: Session["transportMeta"],
  incoming: IncomingMessage["transportMeta"],
): Session["transportMeta"] {
  const baseExisting = (existing && typeof existing === "object" && !Array.isArray(existing))
    ? (existing as Record<string, unknown>)
    : {};
  const baseIncoming = (incoming && typeof incoming === "object" && !Array.isArray(incoming))
    ? (incoming as Record<string, unknown>)
    : {};

  const merged: Record<string, unknown> = { ...baseExisting, ...baseIncoming };

  // Preserve Jinn internal keys from being overwritten by transport adapters.
  // Engine thread ids are not among them: they live in the typed engineSessions
  // column the registry owns, out of reach of any connector merge.
  for (const key of [
    "engineOverride",
    "claudeSyncSince",
    "engineSyncTarget",
    "engineSyncSince",
    "transcriptSyncedThrough",
    "transcriptActivityAt",
    "delegationCompletionTracked",
    "delegationCompletionContract",
    AUTO_COMPACT_BUDGET_HOLD_KEY,
  ]) {
    if (baseExisting[key] !== undefined) merged[key] = baseExisting[key];
  }

  return merged as any;
}

export class SessionManager {
  private config: JinnConfig;
  private engines: Map<string, Engine>;
  private gatewayBootId: string;
  private queue = new SessionQueue();
  private connectorProvider: () => Map<string, Connector> = () => new Map();
  private gatewayEmit: GatewayEmit | undefined;

  constructor(
    config: JinnConfig,
    engines: Map<string, Engine>,
    gatewayBootId = "",
  ) {
    this.config = config;
    this.engines = engines;
    this.gatewayBootId = gatewayBootId;
  }
  setConnectorProvider(provider: () => Map<string, Connector>): void {
    this.connectorProvider = provider;
  }

  setGatewayEmitter(next: GatewayEmit | undefined): void {
    this.gatewayEmit = next;
  }

  /** Live connector ids — reflects reloads, with no cached copy to refresh. */
  private connectorNames(): string[] { return [...this.connectorProvider().keys()]; }

  setConfig(config: JinnConfig): void {
    this.config = config;
  }

  getEngine(name: string): Engine | undefined {
    return this.engines.get(name);
  }

  getEngines(): Map<string, Engine> {
    return this.engines;
  }

  getQueue(): SessionQueue {
    return this.queue;
  }

  async route(msg: IncomingMessage, connector: Connector, opts: RouteOptions = {}): Promise<{ sessionId: string } | void> {
    if (await this.handleCommand(msg, connector)) return;

    let session = getSessionBySessionKey(msg.sessionKey);
    if (!session) {
      session = createSession({
        ...newSessionEngineSelection(this.config, this.engines, opts),
        source: msg.source,
        sourceRef: msg.sessionKey,
        connector: msg.connector,
        sessionKey: msg.sessionKey,
        replyContext: msg.replyContext,
        messageId: msg.messageId,
        transportMeta: msg.transportMeta,
        employee: opts.employee?.name ?? undefined,
        title: opts.title,
        prompt: msg.text,
        portalName: this.config.portal?.portalName,
      });
      logger.info(
        `Created new session ${session.id} for ${msg.sessionKey}` +
        (opts.employee ? ` (employee: ${opts.employee.name})` : ""),
      );
    } else {
      const mergedMeta = mergeTransportMeta(session.transportMeta, msg.transportMeta);
      session = updateSession(session.id, {
        replyContext: msg.replyContext,
        messageId: msg.messageId ?? null,
        transportMeta: mergedMeta,
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.effortLevel ? { effortLevel: opts.effortLevel } : {}),
      }) ?? session;
    }

    session = maybeRevertEngineOverride(session);
    this.queue.clearCancelled(msg.sessionKey);

    const target = connector.reconstructTarget(msg.replyContext);
    target.messageTs ??= msg.messageId;

    const attachmentPaths = msg.attachments
      .map((attachment) => attachment.localPath)
      .filter((filePath): filePath is string => !!filePath);

    if (session.status === "waiting") {
      // A new user message on a rate-limit-paused session is an explicit "retry
      // now" (e.g. the user cleared the limit provider-side). handleRateLimit's
      // wait loop is sleeping until the engine's own reported resetsAt while
      // holding this session's serial queue slot, so queueing behind it would
      // park the message on a now-stale reset and keep replying "still limited".
      // Flip out of `waiting` so that loop unwinds as cancelled and frees the
      // queue; the enqueue below then runs immediately on the now-available engine.
      session = updateSession(session.id, {
        status: "idle",
        lastActivity: new Date().toISOString(),
        lastError: null,
      }) ?? session;
    }

    if (session.status === "running" && this.queue.isRunning(msg.sessionKey) && connector.getCapabilities().reactions) {
      await connector.addReaction(target, "clock1").catch(() => {});
    }

    const sessionId = session.id;

    await this.queue.enqueue(msg.sessionKey, () =>
      this.runSession(session!, msg, attachmentPaths, connector, target, opts.employee),
    );

    return { sessionId };
  }

  private async runSession(
    session: Session,
    msg: IncomingMessage,
    attachments: string[],
    connector: Connector,
    target: Target,
    employee?: Employee,
  ): Promise<void> {
    const liveSession = getSession(session.id);
    if (!liveSession) {
      logger.warn(`Skipping queued turn for deleted session ${session.id}`);
      return;
    }
    session = liveSession;

    insertMessage(session.id, "user", msg.text);

    // Mark running before anything else can fail, so a preflight error settles
    // the attempt instead of leaving the session looking idle with a live token.
    const startedAttempt = beginSessionAttempt(session.id, {
      replyContext: msg.replyContext,
      messageId: msg.messageId ?? null,
      transportMeta: mergeTransportMeta(session.transportMeta, msg.transportMeta),
      lastActivity: new Date().toISOString(),
    });
    if (!startedAttempt?.attemptToken) return;

    const surface = createConnectorTurnSurface({
      connector,
      target,
      session: startedAttempt,
      config: this.config,
      decorate: session.source !== "cron",
      emit: this.gatewayEmit,
    });

    try {
      await runTurn({
        session: startedAttempt,
        attemptToken: startedAttempt.attemptToken,
        prompt: msg.text,
        attachments,
        employee,
        config: this.config,
        engines: this.engines,
        gatewayBootId: this.gatewayBootId,
        connectorNames: this.connectorNames(),
        roster: await resolveTurnHierarchy(this.config),
        channel: msg.channel,
        thread: msg.thread,
        user: msg.user,
        channelName: (msg.transportMeta?.channelName as string) || undefined,
        // Re-read at settle time: a connector can move the reply target while
        // the turn runs, and the receipt must record where it actually landed.
        terminalFields: () => ({
          replyContext: msg.replyContext,
          messageId: msg.messageId ?? null,
          transportMeta: mergeTransportMeta(
            getSessionBySessionKey(msg.sessionKey)?.transportMeta ?? startedAttempt.transportMeta,
            msg.transportMeta,
          ),
        }),
        announceUsageWarnings: session.source !== "cron",
      }, surface);
    } finally {
      // Clean up temp attachment files downloaded from the connector.
      for (const filePath of attachments) {
        try {
          fs.rmSync(filePath, { force: true });
        } catch {
          // Ignore cleanup errors — best effort.
        }
      }

      // NOTE: neither the interactive engine's per-session --settings file NOR its
      // --mcp-config file is cleaned up here. A warm PTY survives across turns and
      // keeps both paths on its command line for its entire life (a cold respawn on
      // model/effort change re-reads --mcp-config). Their lifetime is owned by
      // PtyLifecycleManager (onCleanup), not the per-turn runSession lifecycle.
    }
  }

  async handleCommand(msg: IncomingMessage, connector: Connector): Promise<boolean> {
    const text = msg.text.trim();
    const target = connector.reconstructTarget(msg.replyContext);
    target.messageTs ??= msg.messageId;

    if (text === "/new" || text.startsWith("/new ")) {
      this.resetSession(msg.sessionKey);
      await connector.replyMessage(target, "Session reset. Starting fresh.");
      logger.info(`Session reset for ${msg.sessionKey}`);
      return true;
    }

    if (text === "/status" || text.startsWith("/status ")) {
      const session = getSessionBySessionKey(msg.sessionKey);
      if (!session) {
        await connector.replyMessage(target, "No active session for this conversation.");
        return true;
      }

      const queueDepth = this.queue.getPendingCount(session.sessionKey);
      const transportState = this.queue.getTransportState(session.sessionKey, session.status);
      const info = [
        `Session: ${session.id}`,
        `Engine: ${session.engine}`,
        `Connector: ${session.connector || session.source}`,
        `Model: ${session.model || this.config.engines[session.engine as "claude" | "codex" | "antigravity" | "grok" | "pi" | "hermes" | "opencode"]?.model || "default"}`,
        `State: ${transportState}`,
        `Queue depth: ${queueDepth}`,
        `Created: ${session.createdAt}`,
        `Last activity: ${session.lastActivity}`,
        session.lastError ? `Last error: ${session.lastError}` : null,
      ].filter(Boolean).join("\n");

      await connector.replyMessage(target, info);
      return true;
    }

    if (text.startsWith("/model")) {
      const nextModel = text.slice("/model".length).trim();
      if (!nextModel) {
        await connector.replyMessage(target, "Usage: /model <model-name>");
        return true;
      }

      const session = getSessionBySessionKey(msg.sessionKey);
      if (!session) {
        await connector.replyMessage(target, "No active session for this conversation.");
        return true;
      }

      updateSession(session.id, {
        model: nextModel,
        lastActivity: new Date().toISOString(),
      });
      await connector.replyMessage(target, `Model updated to \`${nextModel}\` for this session.`);
      return true;
    }

    if (text === "/doctor" || text.startsWith("/doctor ")) {
      const connectors = Array.from(this.connectorProvider().values());
      const connectorLines = connectors.length > 0
        ? connectors.map((candidate) => {
            const health = candidate.getHealth();
            return `- ${candidate.name}: ${health.status}${health.detail ? ` (${health.detail})` : ""}`;
          })
        : ["- none"];
      const info = [
        `Default engine: ${this.config.engines.default}`,
        `Claude: ${this.config.engines.claude.model}`,
        `Codex: ${this.config.engines.codex.model}`,
        ...(this.config.engines.antigravity ? [`Antigravity: ${this.config.engines.antigravity.model ?? "Gemini 3.5 Flash (Medium)"}`] : []),
        ...(this.config.engines.grok ? [`Grok: ${this.config.engines.grok.model ?? "grok-build"}`] : []),
        "Connectors:",
        ...connectorLines,
      ].join("\n");
      await connector.replyMessage(target, info);
      return true;
    }

    if (text.startsWith("/cron")) {
      return this.handleCronCommand(text, connector, target);
    }

    return false;
  }

  resetSession(sessionKey: string): void {
    const session = getSessionBySessionKey(sessionKey);
    if (session) {
      // Tear down any live/warm engine process before deleting or preserving the session.
      for (const engine of this.engines.values()) {
        if (isInterruptibleEngine(engine)) {
          engine.kill(session.id, "Interrupted: session reset");
        }
      }
      this.queue.clearQueue(session.sessionKey || session.sourceRef || session.id);
      ptySnapshotStore.deleteSync(session.id);
      if (session.workItemId) {
        const unresolved = !session.attemptOutcome || session.status === "running" || session.status === "waiting";
        updateSession(session.id, {
          // Detach the retained evidence from the connector thread so /new still
          // creates a fresh conversational session on the next message.
          sessionKey: `archived:${session.id}`,
          ...(unresolved ? {
            status: "interrupted" as const,
            attemptOutcome: "interrupted" as const,
            lastError: "Interrupted: session reset",
          } : {}),
          lastActivity: new Date().toISOString(),
        });
        reconcileWorkItem(session.workItemId);
        logger.info(`Preserved linked session ${session.id} as Todo execution evidence`);
        return;
      }
      deleteSession(session.id);
      // Remove any per-session Codex CODEX_HOME overlay (no-op for non-codex
      // sessions). Safe here because the session is ending — the thread rollout
      // under it is no longer needed. Idempotent.
      removeCodexSessionHome(session.id);
      logger.info(`Deleted session ${session.id}`);
    }
  }

  private async handleCronCommand(text: string, connector: Connector, target: Target): Promise<boolean> {
    const [_, subcommand = "", ...rest] = text.split(/\s+/);
    const arg = rest.join(" ").trim();

    if (!subcommand || subcommand === "list") {
      const jobs = loadJobs();
      if (jobs.length === 0) {
        await connector.replyMessage(target, "No cron jobs configured.");
        return true;
      }

      const lines = jobs.map((job) =>
        `- ${job.name} (${job.id}) — ${job.enabled ? "enabled" : "disabled"} — ${job.schedule}`,
      );
      await connector.replyMessage(target, ["Cron jobs:", ...lines].join("\n"));
      return true;
    }

    if (subcommand === "run") {
      if (!arg) {
        await connector.replyMessage(target, "Usage: /cron run <job-id-or-name>");
        return true;
      }
      const job = await triggerCronJob(arg);
      await connector.replyMessage(
        target,
        job ? `Triggered cron job "${job.name}".` : `Cron job "${arg}" not found.`,
      );
      return true;
    }

    if (subcommand === "enable" || subcommand === "disable") {
      if (!arg) {
        await connector.replyMessage(target, `Usage: /cron ${subcommand} <job-id-or-name>`);
        return true;
      }
      const job = setCronJobEnabled(arg, subcommand === "enable");
      await connector.replyMessage(
        target,
        job
          ? `Cron job "${job.name}" ${job.enabled ? "enabled" : "disabled"}.`
          : `Cron job "${arg}" not found.`,
      );
      return true;
    }

    await connector.replyMessage(target, "Usage: /cron [list|run|enable|disable] <job-id-or-name>");
    return true;
  }
}
