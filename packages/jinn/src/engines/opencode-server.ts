import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";
import { logger } from "../shared/logger.js";
import { JINN_HOME } from "../shared/paths.js";
import { resolveBin } from "../shared/resolve-bin.js";
import { assertRemoteTarget, isRemoteTarget } from "../shared/remote-target.js";
import type { RemoteTarget, ResolvedMcpConfig } from "../shared/types.js";
import type { OpencodeMode, OpencodeServerConfig, RemoteExecutionConfig } from "../shared/config-types.js";
import type { PtyHandle, PtyLifecycleManager } from "./pty-lifecycle.js";
import {
  buildOpencodeSessionConfig,
  cleanupOpencodeSessionConfig,
  writeOpencodeSessionConfig,
  type OpencodeConfigHandle,
} from "./opencode-mcp.js";
import { buildOpencodeServeArgs } from "./opencode-protocol.js";
import { cleanEnv, REMOTE_ENV_DENY } from "./opencode-launch.js";
import {
  buildSshSpawnArgs,
  ensureRemoteReady,
  prepareRemoteSession,
  probeFreePort,
  reapStaleRemoteEngine,
  RemoteKills,
  remoteNodeDir,
  remoteSessionBinDir,
  requireRemoteEngineBin,
  type RemoteEngineHandle,
  type RemoteFacts,
  type RemoteOpencodeStaging,
} from "./remote-stage.js";

/**
 * opencode server mode: one `opencode serve` per Jinn session.
 *
 * opencode is client/server. Its TUI is a client of an HTTP server, and
 * `opencode attach <url>` is the TUI on its own. So one server per session lets
 * a Jinn turn (sent over the API, `opencode-server-turn.ts`) and the operator's
 * terminal view share a session live, the way the interactive Claude engine's
 * do, without screen-scraping anything: the turn is still parsed by
 * `OpencodeTurn`, and interrupts go through the server's own API.
 *
 * This file owns the SERVERS. Turns (`opencode.ts`) and the terminal view
 * (`opencode-interactive.ts`) acquire a session's server from here, and never
 * start or stop one themselves.
 *
 * Why a server per session and not per host: the jinn MCP server a session
 * talks to carries that session's identity in its environment, and an opencode
 * server loads one MCP set for everything it serves.
 *
 * Lifetime. A server is registered with a {@link PtyLifecycleManager}, so it
 * counts toward the gateway-wide idle cap every interactive engine shares, and
 * a running turn or an attached viewer keeps it alive. On top of that this
 * pool stops idle servers past a per-host count and past an age, because a warm
 * server is a full opencode process (~650 MB) plus its MCP servers.
 */

/** Everything that decides WHICH server a session needs. Two specs with the same
 *  fingerprint can share a running server; any difference means a new one. */
export interface OpencodeServerSpec extends RemoteTarget {
  /** Working directory for a local server. A remote one runs in `remoteCwd`. */
  cwd: string;
  /** `engines.opencode.bin`. Local servers only: a remote host's binary is the
   *  one its facts probe found, exactly as for a remote `run` turn. */
  bin?: string;
  resolvedMcp?: ResolvedMcpConfig;
}

export interface OpencodeServer {
  /** The Jinn session this server belongs to. */
  sessionId: string;
  /** `local`, or the employee's `remoteHost` as written — the key the per-host
   *  idle cap is configured by. */
  hostKey: string;
  fingerprint: string;
  /** Where the GATEWAY reaches the API: the server itself, or the local end of
   *  the ssh `-L` forward to it. */
  apiUrl: string;
  /** Where a client on the server's OWN host reaches it — what the terminal
   *  view's `opencode attach` is given. The same as {@link apiUrl} for a local server. */
  hostUrl: string;
  /** Per-server HTTP basic-auth password (`OPENCODE_SERVER_PASSWORD`). Every
   *  process on a host can reach its loopback; this is what stops them driving
   *  a session that runs tools with `--dangerously-skip-permissions`. */
  password: string;
  /** The opencode binary on the server's host. */
  bin: string;
  /** Local working directory the server runs in (remote: see {@link remote}). */
  cwd: string;
  remote?: {
    destination: string;
    remoteCwd: string;
    facts: RemoteFacts;
    staging: RemoteOpencodeStaging;
    /** How a kill finds `opencode serve` again over there. */
    handle: RemoteEngineHandle;
  };
  proc: ChildProcess;
  exited: boolean;
  /** Set once the health check has answered; until then nothing is sent to it. */
  ready: boolean;
  /** The opencode session the last turn named: where the terminal view attaches. */
  engineSessionId?: string;
  configHandle?: OpencodeConfigHandle;
  output: string;
}

export interface OpencodeServerPoolDeps {
  remote?: () => RemoteExecutionConfig | undefined;
  gatewayPort?: () => number;
  /** `engines.opencode.server`, read live so a hot reload applies. */
  limits?: () => OpencodeServerConfig | undefined;
  /** `engines.opencode.bin`, for a server started without a turn's opts. */
  bin?: () => string | undefined;
}

/**
 * The oldest opencode server mode runs against: the version its HTTP API, event
 * stream and Part shapes were verified on (build-host, 2026-09-24). Server mode
 * reads those shapes rather than the CLI's `--format json` contract, so an
 * older or unknown server is refused and that host's turns use `run` mode.
 */
export const MIN_OPENCODE_SERVER_VERSION = "1.18.31";
/** How long a host stays on `run` mode after its server was found unusable
 *  (too old, or its API no longer matching), before server mode is retried. */
export const UNSUPPORTED_RETRY_MS = 60 * 60 * 1000;

export const DEFAULT_MAX_IDLE_SERVERS = 2;
export const DEFAULT_SERVER_IDLE_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_SERVER_START_TIMEOUT_MS = 30_000;
/** How long a healthy server may take to bootstrap its instance (see
 *  {@link OpencodeServerPool.waitBootstrapped}). Long, because what it waits for
 *  is real work — a first plugin install downloads from npm — and giving up
 *  only moves that work into a plain `run`, which then pays for it again. */
export const DEFAULT_SERVER_BOOTSTRAP_TIMEOUT_MS = 120_000;
const SWEEP_INTERVAL_MS = 60_000;
const HEALTH_POLL_MS = 200;
const API_TIMEOUT_MS = 5_000;
/** How long an abort may take to leave the turn stopped before the whole
 *  server is stopped instead — which kills its tools with it. */
const ABORT_SETTLE_MS = 15_000;
/** How long the turn must stay quiet before an abort counts: longer than the
 *  slowest prompt pick-up seen on 1.18.31 (~710 ms), so a prompt that had not
 *  started when the first abort landed is caught when it does. */
const ABORT_CONFIRM_MS = 1_500;
const ABORT_POLL_MS = 150;
const OUTPUT_MAX = 4 * 1024;

/** The mode `engines.opencode.mode` names. Anything but `server` is `run`, so a
 *  typo falls back to the behaviour that existed before the option did. */
export function opencodeMode(cfg: { mode?: unknown } | undefined): OpencodeMode {
  return cfg?.mode === "server" ? "server" : "run";
}

export function serverHostKey(target: RemoteTarget): string {
  return isRemoteTarget(target) ? target.remoteHost : "local";
}

/** The idle-server cap for one host under `limits`. */
export function idleCapForHost(limits: OpencodeServerConfig | undefined, hostKey: string): number {
  const byHost = limits?.maxIdleByHost?.[hostKey];
  const cap = typeof byHost === "number" ? byHost : limits?.maxIdle;
  return typeof cap === "number" && Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) : DEFAULT_MAX_IDLE_SERVERS;
}

/** Which server a spec needs. Covers everything the server is STARTED with:
 *  where it runs, which binary, and the MCP set (with the session's identity in
 *  it). Model and prompt are per turn and are not part of it. */
export function serverFingerprint(spec: OpencodeServerSpec): string {
  const where = isRemoteTarget(spec)
    ? { host: spec.remoteHost, user: spec.remoteUser ?? "", cwd: spec.remoteCwd ?? "" }
    : { cwd: spec.cwd, bin: resolveBin("opencode", spec.bin) };
  const mcp = buildOpencodeSessionConfig(spec.resolvedMcp) ?? null;
  return crypto.createHash("sha256").update(JSON.stringify({ where, mcp })).digest("hex");
}

/** Compare dotted numeric versions: negative when a < b. A pre-release or build
 *  suffix is ignored, and a missing part counts as 0. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/, "").split(/[-+]/)[0]!.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Why a server of this version cannot be used, or undefined when it can. */
export function unsupportedVersionReason(version: string | undefined): string | undefined {
  if (!version) return `the server did not report its version (server mode needs opencode >= ${MIN_OPENCODE_SERVER_VERSION})`;
  return compareVersions(version, MIN_OPENCODE_SERVER_VERSION) < 0
    ? `opencode ${version} is older than ${MIN_OPENCODE_SERVER_VERSION}, the oldest version server mode is verified against`
    : undefined;
}

export function basicAuthHeader(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
}

/** A free TCP port on this machine's loopback. The window between this and the
 *  server binding it is covered by a failed start being reported, not hidden. */
export async function freeLocalPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port > 0 ? resolve(port) : reject(new Error("no free local port"))));
    });
  });
}

export class OpencodeServerPool {
  private servers = new Map<string, OpencodeServer>();
  private starting = new Map<string, Promise<OpencodeServer>>();
  /** Callers currently using each session's server (turns and terminal views). */
  private holds = new Map<string, number>();
  /** Hosts whose server was found unusable, and when: their turns use `run`
   *  mode until {@link UNSUPPORTED_RETRY_MS} has passed. */
  private unsupported = new Map<string, { reason: string; at: number }>();
  private remoteKills = new RemoteKills("opencode server");
  private startedListeners: Array<(server: OpencodeServer) => void> = [];
  private releasedListeners: Array<(sessionId: string) => void> = [];
  private sessionListeners: Array<(sessionId: string, engineSessionId: string) => void> = [];
  private sweepTimer?: NodeJS.Timeout;

  constructor(private readonly lifecycle: PtyLifecycleManager, private readonly deps: OpencodeServerPoolDeps = {}) {
    lifecycle.onRelease((sessionId) => this.forget(sessionId));
  }

  /** The session's running server, if it has one. */
  get(sessionId: string): OpencodeServer | undefined {
    const server = this.servers.get(sessionId);
    return server && server.ready && !server.exited ? server : undefined;
  }

  /** The session has a server, running or starting. */
  hasServer(sessionId: string): boolean {
    return this.starting.has(sessionId) || this.get(sessionId) !== undefined;
  }

  size(): number {
    return this.servers.size;
  }

  livePids(): number[] {
    return this.lifecycle.livePids();
  }

  onStarted(listener: (server: OpencodeServer) => void): void {
    this.startedListeners.push(listener);
  }

  onReleased(listener: (sessionId: string) => void): void {
    this.releasedListeners.push(listener);
  }

  onEngineSession(listener: (sessionId: string, engineSessionId: string) => void): void {
    this.sessionListeners.push(listener);
  }

  /**
   * The session's server, started if it has none, with a HOLD on it for the
   * caller: a held server is never stopped by an idle cap or the idle age.
   * Every successful acquire must be paired with one {@link release}.
   * Concurrent callers share one start.
   *
   * A turn (`reuseAny` false) needs the server its spec describes, and replaces
   * one started for a different spec — stopping the old one first, because two
   * opencode processes writing one session is the failure this mode exists to
   * remove. Turns on one session are serialized by the session queue, so the
   * only thing a replacement can cut off is a terminal view or a prompt the
   * operator typed there.
   *
   * The terminal view (`reuseAny` true) takes whatever server the session
   * already has: it only watches, and replacing a server mid-turn to suit a
   * viewer would kill the turn. With `existingOnly` it starts nothing either,
   * and fails when the session has no server running or starting.
   */
  async acquire(
    sessionId: string,
    spec: OpencodeServerSpec,
    opts: { reuseAny?: boolean; existingOnly?: boolean } = {},
  ): Promise<OpencodeServer> {
    const off = this.unsupportedReason(serverHostKey(spec));
    if (off) throw new Error(`server mode is off for this host: ${off}`);
    const server = opts.existingOnly
      ? await this.existingServer(sessionId)
      : await this.acquireServer(sessionId, spec, opts.reuseAny === true);
    this.hold(sessionId);
    return server;
  }

  /** Drop one hold taken by {@link acquire}. A no-op once the server is gone. */
  release(sessionId: string): void {
    const count = this.holds.get(sessionId);
    if (!count) return;
    if (count > 1) {
      this.holds.set(sessionId, count - 1);
      return;
    }
    this.holds.delete(sessionId);
    // Stamp the moment it went idle: the lifecycle measures idleness from the
    // end of the last turn, and a hold is this pool's notion of a turn.
    this.lifecycle.turnStarted(sessionId);
    this.lifecycle.setRuntimeActive(sessionId, false);
    this.lifecycle.turnEnded(sessionId);
    this.enforceIdleLimits();
  }

  holdCount(sessionId: string): number {
    return this.holds.get(sessionId) ?? 0;
  }

  private hold(sessionId: string): void {
    this.holds.set(sessionId, (this.holds.get(sessionId) ?? 0) + 1);
    this.lifecycle.setRuntimeActive(sessionId, true);
    // `start` adopts with turnRunning so nothing can take the server while it
    // comes up; the hold protects it from here on.
    this.lifecycle.turnEnded(sessionId);
  }

  /**
   * Take a host off server mode: its server was too old, or its API stopped
   * matching what a turn reads. Later turns on that host run as plain `opencode
   * run` (a server that will not start is the `run` fallback in the engine)
   * rather than risk silently dropping events, until the retry window passes.
   */
  markUnsupported(hostKey: string, reason: string, now = Date.now()): void {
    if (!this.unsupported.has(hostKey)) {
      logger.warn(`opencode server mode disabled for host ${hostKey} for ${Math.round(UNSUPPORTED_RETRY_MS / 60000)} minutes: ${reason}`);
    }
    this.unsupported.set(hostKey, { reason, at: now });
  }

  /** Why server mode is currently off for this host, if it is. */
  unsupportedReason(hostKey: string, now = Date.now()): string | undefined {
    const entry = this.unsupported.get(hostKey);
    if (!entry) return undefined;
    if (now - entry.at >= UNSUPPORTED_RETRY_MS) {
      this.unsupported.delete(hostKey);
      return undefined;
    }
    return entry.reason;
  }

  /** The session's server, running or once started; never one started here. */
  private async existingServer(sessionId: string): Promise<OpencodeServer> {
    const pending = this.starting.get(sessionId);
    const started = pending ? await pending.catch(() => undefined) : undefined;
    const server = started && !started.exited ? started : this.get(sessionId);
    if (!server) throw new Error("no opencode server is running for this session");
    return server;
  }

  private async acquireServer(sessionId: string, spec: OpencodeServerSpec, reuseAny: boolean): Promise<OpencodeServer> {
    const fingerprint = serverFingerprint(spec);
    const pending = this.starting.get(sessionId);
    if (pending) {
      const started = await pending.catch(() => undefined);
      if (started && !started.exited && (reuseAny || started.fingerprint === fingerprint)) return started;
    }
    const live = this.get(sessionId);
    if (live && (reuseAny || live.fingerprint === fingerprint)) return live;
    if (live) {
      logger.info(`opencode server for session ${sessionId} was started for a different spec (MCP set, host or cwd); replacing it`);
      await this.stop(sessionId);
    }
    const start = this.start(sessionId, spec, fingerprint).finally(() => {
      if (this.starting.get(sessionId) === start) this.starting.delete(sessionId);
    });
    this.starting.set(sessionId, start);
    return await start;
  }

  /** Stop the session's server, and wait (bounded) for it to be gone. */
  async stop(sessionId: string): Promise<void> {
    const server = this.servers.get(sessionId);
    if (!server) return;
    this.lifecycle.releaseSession(sessionId);
    await waitForExit(server, 10_000);
  }

  /** Stop every server; resolves once they are gone (bounded). The mode
   *  flipped back to `run`, or the gateway is going. */
  async stopAll(): Promise<void> {
    const servers = [...this.servers.values()];
    this.lifecycle.killAll();
    await Promise.all(servers.map((server) => waitForExit(server, 10_000)));
  }

  /** Remote server kills still in flight, for a shutdown to wait on. */
  pendingRemoteKills(): Promise<unknown> {
    return this.remoteKills.pending();
  }

  /** A turn's stream named the opencode session it runs in. */
  noteEngineSession(sessionId: string, engineSessionId: string): void {
    const server = this.get(sessionId);
    if (!server || server.engineSessionId === engineSessionId) return;
    server.engineSessionId = engineSessionId;
    for (const listener of this.sessionListeners) listener(sessionId, engineSessionId);
  }

  /**
   * Stop one turn on the server, and wait until it is certainly stopped.
   *
   * Dropping a client does NOT stop a turn: the server keeps generating and
   * running tools. And an abort posted before opencode has picked the prompt up
   * is silently lost — the session is not busy yet, so there is nothing to
   * abort, and the prompt then starts anyway (verified on 1.18.31: aborted at
   * 0 ms it never ran, at 20 ms it ran to completion, once busy it always
   * stopped). So this keeps aborting the turn's own session until the server
   * has shown it quiet — not busy, and the turn's reply ended or absent — for a
   * whole confirmation window, longer than the slowest pick-up seen (~710 ms).
   * If that cannot be had within the bound, the server itself is stopped,
   * which ends its tools too.
   *
   * Only the turn's own session is aborted. A prompt the operator runs in
   * another session on the same server is theirs.
   */
  async abortTurn(sessionId: string, target: { engineSessionId: string; userMessageId: string }): Promise<void> {
    const server = this.get(sessionId);
    if (!server) return;
    const abort = () => this.request(server, `/session/${encodeURIComponent(target.engineSessionId)}/abort`, { method: "POST" });
    try {
      await abort();
      const deadline = Date.now() + ABORT_SETTLE_MS;
      let quietSince = 0;
      for (;;) {
        await sleep(ABORT_POLL_MS);
        if (await this.turnStillRunning(server, target)) {
          quietSince = 0;
          await abort();
        } else if (!quietSince) {
          quietSince = Date.now();
        } else if (Date.now() - quietSince >= ABORT_CONFIRM_MS) {
          return;
        }
        if (Date.now() > deadline) throw new Error("the turn was still running after repeated aborts");
      }
    } catch (err) {
      logger.warn(
        `Could not confirm the abort on the opencode server for session ${sessionId} `
        + `(${err instanceof Error ? err.message : String(err)}); stopping the server instead`,
      );
      await this.stop(sessionId);
    }
  }

  /** Busy, or the turn's reply exists and has not ended. */
  private async turnStillRunning(server: OpencodeServer, target: { engineSessionId: string; userMessageId: string }): Promise<boolean> {
    if ((await this.busySessions(server)).includes(target.engineSessionId)) return true;
    const messages = await this.request(server, `/session/${encodeURIComponent(target.engineSessionId)}/message`, { method: "GET" });
    if (!Array.isArray(messages)) return false;
    return messages.some((m: { info?: { role?: string; parentID?: string; time?: { completed?: number }; error?: unknown } }) =>
      m.info?.role === "assistant" && m.info.parentID === target.userMessageId && !m.info.time?.completed && !m.info.error);
  }

  /** Send a prompt into an opencode session without waiting for the answer. */
  async promptAsync(sessionId: string, engineSessionId: string, text: string): Promise<void> {
    const server = this.get(sessionId);
    if (!server) throw new Error("no opencode server for this session");
    await this.request(server, `/session/${encodeURIComponent(engineSessionId)}/prompt_async`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text }] }),
    });
  }

  /** Stop idle servers past the idle age, then past the per-host count. */
  enforceIdleLimits(now = Date.now()): void {
    const limits = this.deps.limits?.();
    const ttl = idleTtl(limits);
    const byHost = new Map<string, Array<{ sessionId: string; idleSince: number }>>();
    for (const candidate of this.idleServers()) {
      if (now - candidate.idleSince >= ttl) {
        logger.info(`opencode server for session ${candidate.sessionId} idle for ${Math.round((now - candidate.idleSince) / 1000)}s; stopping it`);
        this.lifecycle.releaseSession(candidate.sessionId);
        continue;
      }
      const list = byHost.get(candidate.hostKey) ?? [];
      list.push(candidate);
      byHost.set(candidate.hostKey, list);
    }
    for (const [hostKey, list] of byHost) this.capHost(hostKey, list, idleCapForHost(limits, hostKey));
  }

  /** Servers nobody holds and that are not still starting, with their host. */
  private idleServers(): Array<{ sessionId: string; idleSince: number; hostKey: string }> {
    const out: Array<{ sessionId: string; idleSince: number; hostKey: string }> = [];
    for (const candidate of this.lifecycle.idleCandidates()) {
      const server = this.servers.get(candidate.sessionId);
      if (!server || this.starting.has(candidate.sessionId)) continue;
      out.push({ sessionId: candidate.sessionId, idleSince: candidate.idleSince, hostKey: server.hostKey });
    }
    return out;
  }

  private capHost(hostKey: string, idle: Array<{ sessionId: string; idleSince: number }>, cap: number): void {
    const stalestFirst = [...idle].sort((a, b) => a.idleSince - b.idleSince);
    for (const victim of stalestFirst.slice(0, Math.max(0, stalestFirst.length - cap))) {
      logger.info(`opencode server for session ${victim.sessionId} stopped: over the idle cap of ${cap} for host ${hostKey}`);
      this.lifecycle.releaseSession(victim.sessionId);
    }
  }

  // ── Starting ─────────────────────────────────────────────────────────────

  private async start(sessionId: string, spec: OpencodeServerSpec, fingerprint: string): Promise<OpencodeServer> {
    const password = crypto.randomBytes(24).toString("base64url");
    const server = isRemoteTarget(spec)
      ? await this.spawnRemote(sessionId, spec, fingerprint, password)
      : await this.spawnLocal(sessionId, spec, fingerprint, password);
    this.servers.set(sessionId, server);
    // Adopted as busy, so neither cap can stop it while it is still starting.
    this.lifecycle.adopt(sessionId, this.handleFor(server), { turnRunning: true });
    this.armSweep();

    let version: string | undefined;
    try {
      version = await this.waitHealthy(server, this.startTimeoutMs());
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      const output = server.output.trim().split("\n").slice(-5).join(" | ");
      await this.stop(sessionId);
      throw new Error(`opencode server did not start: ${why}${output ? ` (${output})` : ""}`);
    }
    const tooOld = unsupportedVersionReason(version);
    if (tooOld) {
      this.markUnsupported(server.hostKey, tooOld);
      await this.stop(sessionId);
      throw new Error(`opencode server refused: ${tooOld}`);
    }
    const bootstrapStart = Date.now();
    try {
      await this.waitBootstrapped(server, this.bootstrapTimeoutMs());
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      const output = server.output.trim().split("\n").slice(-5).join(" | ");
      await this.stop(sessionId);
      throw new Error(`opencode server did not start: ${why}${output ? ` (${output})` : ""}`);
    }
    server.ready = true;
    logger.info(
      `opencode server ready for session ${sessionId} on ${server.hostKey} (${server.apiUrl}; `
      + `instance bootstrapped in ${Date.now() - bootstrapStart}ms)`,
    );
    for (const listener of this.startedListeners) listener(server);
    this.enforceIdleLimits();
    return server;
  }

  private startTimeoutMs(): number {
    const ms = this.deps.limits?.()?.startTimeoutMs;
    return typeof ms === "number" && ms > 0 ? ms : DEFAULT_SERVER_START_TIMEOUT_MS;
  }

  private bootstrapTimeoutMs(): number {
    const ms = this.deps.limits?.()?.bootstrapTimeoutMs;
    return typeof ms === "number" && ms > 0 ? ms : DEFAULT_SERVER_BOOTSTRAP_TIMEOUT_MS;
  }

  private async spawnLocal(
    sessionId: string,
    spec: OpencodeServerSpec,
    fingerprint: string,
    password: string,
  ): Promise<OpencodeServer> {
    const bin = resolveBin("opencode", spec.bin || this.deps.bin?.());
    const port = await freeLocalPort();
    // A directory of its own, apart from the one a `run` turn stages: the
    // server reads it for its whole life, and a `run` turn deletes its copy
    // when it settles.
    const configHandle = writeOpencodeSessionConfig(spec.resolvedMcp, `${sessionId}.server`);
    const env = {
      ...cleanEnv(sessionId),
      OPENCODE_SERVER_PASSWORD: password,
      ...(configHandle.staged ? { OPENCODE_CONFIG: configHandle.configPath } : {}),
    };
    logger.info(`opencode server starting for session ${sessionId}: ${bin} serve on 127.0.0.1:${port} (jinn tools: ${configHandle.staged ? "on" : "off"})`);
    const proc = spawn(bin, buildOpencodeServeArgs(port), {
      cwd: spec.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      // Its own group, so a stop reaches the tools it started as well.
      detached: process.platform !== "win32",
    });
    const url = `http://127.0.0.1:${port}`;
    return this.track({
      sessionId,
      hostKey: "local",
      fingerprint,
      apiUrl: url,
      hostUrl: url,
      password,
      bin,
      cwd: spec.cwd,
      proc,
      exited: false,
      ready: false,
      configHandle,
      output: "",
    });
  }

  /**
   * A server on the employee's own host.
   *
   * It is staged exactly as a remote `run` turn is (same session home, same
   * 0600 env file, same MCP config), and carried by one long-lived ssh that
   * holds the reverse tunnel the MCP servers reach the gateway through, plus a
   * `-L` forward the gateway reaches the server's API through. Turns and the
   * terminal view connect to the server on its own host, over their own ssh.
   */
  private async spawnRemote(
    sessionId: string,
    spec: OpencodeServerSpec & { remoteHost: string },
    fingerprint: string,
    password: string,
  ): Promise<OpencodeServer> {
    const { staging, facts, gatewayPort } = await this.stageRemote(sessionId, spec, password);
    const bin = requireRemoteEngineBin(staging.destination, facts, "opencode");
    const handle: RemoteEngineHandle = { destination: staging.destination, pidFile: remoteServerPidFile(staging.sessionHome), bin };
    await reapStaleRemoteEngine(handle, "opencode server");

    const serverPort = await probeFreePort(staging.destination, facts);
    const localPort = await freeLocalPort();
    const args = remoteServeSshArgs({ sessionId, spec, staging, facts, bin, gatewayPort, serverPort, localPort, pidFile: handle.pidFile });
    logger.info(
      `opencode server starting REMOTE for session ${sessionId} on ${staging.destination}:${spec.remoteCwd} `
      + `(port ${serverPort}, forwarded from 127.0.0.1:${localPort}, tunnel ${staging.tunnelPort}→${gatewayPort}, `
      + `jinn tools: ${staging.opencodeConfigPath ? "on" : "off"})`,
    );
    const proc = spawn(resolveBin("ssh"), args, {
      cwd: JINN_HOME,
      env: cleanEnv(sessionId),
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    return this.track({
      sessionId,
      hostKey: spec.remoteHost,
      fingerprint,
      apiUrl: `http://127.0.0.1:${localPort}`,
      hostUrl: `http://127.0.0.1:${serverPort}`,
      password,
      bin,
      cwd: JINN_HOME,
      remote: { destination: staging.destination, remoteCwd: spec.remoteCwd!, facts, staging, handle },
      proc,
      exited: false,
      ready: false,
      output: "",
    });
  }

  /** Wake-check the host and stage the session there exactly as a remote `run`
   *  turn is staged, plus the server password in the 0600 env file. */
  private async stageRemote(
    sessionId: string,
    spec: OpencodeServerSpec & { remoteHost: string },
    password: string,
  ): Promise<{ staging: RemoteOpencodeStaging; facts: RemoteFacts; gatewayPort: number }> {
    const remote = this.deps.remote?.();
    assertRemoteTarget(spec, remote);
    const gatewayPort = this.deps.gatewayPort?.() ?? 0;
    if (!gatewayPort) throw new Error("remote spawn needs the gateway's port for the reverse tunnel, and none was provided");
    const readiness = await ensureRemoteReady(spec, remote, { engine: "opencode", allowWake: false });
    if (!readiness.ready) throw new Error(`remote host not ready: ${readiness.reason}`);
    const staging = await prepareRemoteSession({
      target: spec,
      remote: remote!,
      facts: readiness.facts,
      engine: "opencode",
      jinnSessionId: sessionId,
      gatewayPort,
      ...(spec.resolvedMcp ? { resolvedMcp: spec.resolvedMcp } : {}),
      sessionEnv: { OPENCODE_SERVER_PASSWORD: password },
    });
    return { staging, facts: readiness.facts, gatewayPort };
  }

  private track(server: OpencodeServer): OpencodeServer {
    const keep = (d: Buffer) => {
      server.output = (server.output + d.toString()).slice(-OUTPUT_MAX);
    };
    server.proc.stdout?.on("data", keep);
    server.proc.stderr?.on("data", keep);
    server.proc.on("error", (err) => {
      server.output = `${server.output}\n${err.message}`.slice(-OUTPUT_MAX);
      this.onExit(server, null);
    });
    server.proc.on("exit", (code) => this.onExit(server, code));
    return server;
  }

  private onExit(server: OpencodeServer, code: number | null): void {
    if (server.exited) return;
    server.exited = true;
    if (this.servers.get(server.sessionId) === server) {
      logger.info(`opencode server for session ${server.sessionId} exited (code ${code ?? "signal"})`);
      this.lifecycle.releaseSession(server.sessionId);
    }
  }

  private handleFor(server: OpencodeServer): PtyHandle {
    return {
      pid: server.proc.pid ?? 0,
      get killed() { return server.exited; },
      kill: (signal?: string) => this.kill(server, (signal as NodeJS.Signals | undefined) ?? "SIGTERM"),
    };
  }

  /** Stop one server. Remote: the server over there first (with its tools),
   *  then the local ssh client — the same order a remote `run` turn is killed
   *  in, and for the same reason. */
  private kill(server: OpencodeServer, signal: NodeJS.Signals): void {
    if (server.exited) return;
    const signalLocal = () => signalGroup(server.proc, signal);
    if (!server.remote || signal === "SIGKILL") {
      signalLocal();
      return;
    }
    void this.remoteKills.start(server.remote.handle, server.sessionId).finally(signalLocal);
  }

  private forget(sessionId: string): void {
    const server = this.servers.get(sessionId);
    if (!server) return;
    this.servers.delete(sessionId);
    this.holds.delete(sessionId);
    cleanupOpencodeSessionConfig(server.configHandle);
    for (const listener of this.releasedListeners) listener(sessionId);
    if (this.servers.size === 0) this.disarmSweep();
  }

  private armSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.enforceIdleLimits(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  private disarmSweep(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
  }

  // ── HTTP ─────────────────────────────────────────────────────────────────

  /** Wait for the server to answer its health check; resolves to the version it reports. */
  private async waitHealthy(server: OpencodeServer, timeoutMs: number): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs;
    let last = "no answer";
    while (Date.now() < deadline) {
      if (server.exited) throw new Error("the server process exited");
      try {
        const health = await this.request(server, "/global/health", { method: "GET" });
        const version = health && typeof health === "object" ? (health as { version?: unknown }).version : undefined;
        return typeof version === "string" && version ? version : undefined;
      } catch (err) {
        last = err instanceof Error ? err.message : String(err);
      }
      await sleep(HEALTH_POLL_MS);
    }
    throw new Error(`no healthy answer within ${timeoutMs}ms (${last})`);
  }

  /**
   * Wait until the server's event stream connects, i.e. until opencode has
   * bootstrapped the instance for its directory — which a turn's first request
   * would otherwise pay for inside its own short connect budget.
   *
   * `/global/health` answers without an instance. The first request that needs
   * one (`/event` included: `server.connected` is sent only once it exists)
   * loads the config and the plugins, and a config directory whose plugins'
   * dependencies are not installed yet has them installed first — `npm install
   * @opencode-ai/plugin`, or fetching an npm plugin not yet cached. On
   * harry-box (opencode 1.18.32) that took 5.6–24.5 s against ~0.2 s once
   * installed. Opening the stream is the same request the turn makes, so a
   * server that is ready here answers the turn's at once.
   */
  private async waitBootstrapped(server: OpencodeServer, timeoutMs: number): Promise<void> {
    if (server.exited) throw new Error("the server process exited");
    const controller = new AbortController();
    let why = "";
    const stop = (reason: string) => {
      why ||= reason;
      controller.abort();
    };
    const timer = setTimeout(() => stop(`the instance did not bootstrap within ${timeoutMs}ms`), timeoutMs);
    // A remote server's API is an ssh forward, which can outlive the server.
    const exitWatch = setInterval(() => { if (server.exited) stop("the server process exited"); }, HEALTH_POLL_MS);
    try {
      const res = await fetch(`${server.apiUrl}/event`, {
        headers: { authorization: basicAuthHeader(server.password), accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`GET /event answered ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new Error("its event stream closed before the instance bootstrapped");
        buffer = (buffer + decoder.decode(value, { stream: true })).slice(-OUTPUT_MAX);
        if (/"type"\s*:\s*"server\.connected"/.test(buffer)) return;
      }
    } catch (err) {
      if (why) throw new Error(why);
      throw err;
    } finally {
      clearTimeout(timer);
      clearInterval(exitWatch);
      controller.abort();
    }
  }

  private async busySessions(server: OpencodeServer): Promise<string[]> {
    const body = await this.request(server, "/session/status", { method: "GET" });
    const status = body && typeof body === "object" ? body as Record<string, { type?: string }> : {};
    return Object.entries(status)
      .filter(([, value]) => value && typeof value === "object" && value.type && value.type !== "idle")
      .map(([id]) => id);
  }

  private async request(server: OpencodeServer, route: string, init: RequestInit): Promise<unknown> {
    const res = await fetch(`${server.apiUrl}${route}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), authorization: basicAuthHeader(server.password) },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`${init.method ?? "GET"} ${route} answered ${res.status}`);
    const text = await res.text();
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}

/**
 * The ssh that carries a remote `opencode serve`.
 *
 * A tty, so a dropped connection reaches the server as a hangup rather than
 * leaving it running with nobody able to reach it; the pid file is for the
 * deliberate stop, which also has to end the tools it started. The reverse
 * tunnel is for its MCP servers, the `-L` forward for the gateway's API calls.
 */
function remoteServeSshArgs(o: {
  sessionId: string;
  spec: OpencodeServerSpec;
  staging: RemoteOpencodeStaging;
  facts: RemoteFacts;
  bin: string;
  gatewayPort: number;
  serverPort: number;
  localPort: number;
  pidFile: string;
}): string[] {
  return buildSshSpawnArgs({
    destination: o.staging.destination,
    tunnelPort: o.staging.tunnelPort,
    gatewayPort: o.gatewayPort,
    remoteCwd: o.spec.remoteCwd!,
    remoteEnv: {
      JINN_HOME: o.staging.sessionHome,
      JINN_SESSION_ID: o.sessionId,
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      ...(o.staging.opencodeConfigPath ? { OPENCODE_CONFIG: o.staging.opencodeConfigPath } : {}),
    },
    envFile: o.staging.envFilePath,
    unsetRemoteEnv: REMOTE_ENV_DENY,
    pathPrepend: [remoteNodeDir(o.facts), remoteSessionBinDir(o.staging.sessionHome)],
    bin: o.bin,
    args: buildOpencodeServeArgs(o.serverPort),
    allocateTty: true,
    pidFile: o.pidFile,
    localForwards: [{ localPort: o.localPort, remotePort: o.serverPort }],
  });
}

function idleTtl(limits: OpencodeServerConfig | undefined): number {
  const ms = limits?.idleTtlMs;
  return typeof ms === "number" && ms > 0 ? ms : DEFAULT_SERVER_IDLE_TTL_MS;
}

/** Where a remote `opencode serve` records its pid — apart from the per-turn
 *  client's `engine.pid`, since both run at once. */
export function remoteServerPidFile(sessionHome: string): string {
  return path.posix.join(sessionHome, "tmp", "opencode-server.pid");
}

function signalGroup(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  try {
    if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, signal);
    else proc.kill(signal);
  } catch (err) {
    logger.debug(`Failed to send ${signal} to opencode server: ${err instanceof Error ? err.message : err}`);
  }
}

async function waitForExit(server: OpencodeServer, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!server.exited && Date.now() < deadline) await sleep(50);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}
