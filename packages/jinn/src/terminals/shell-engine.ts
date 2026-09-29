import os from "node:os";
import * as pty from "node-pty";
import { PtyStreamManager, setCapped, STREAM_MAP_CAP } from "../engines/pty-stream.js";
import type { SerializedPtySnapshot } from "../engines/pty-snapshot.js";
import type { PtyIdleSpawnOpts, PtySnapshotPersistence, PtySnapshotSubscription, PtyViewEngine, PtyControlEvent } from "../engines/pty-view-engine.js";
import { shq } from "../engines/remote-stage.js";
import { logger } from "../shared/logger.js";
import { resolveBin } from "../shared/resolve-bin.js";
import type { Employee, JinnConfig, Session } from "../shared/types.js";
import { findTerminalHost, listTerminalHosts, type TerminalHost } from "./hosts.js";
import { isTerminalSession } from "./session.js";

export const DEFAULT_MAX_LIVE_TERMINALS = 16;

/** What a spawn needs to know about the terminal's machine, resolved per spawn
 *  from the live config so an edited host takes effect on the next restart. */
export type TerminalHostResolution = { host: TerminalHost } | { error: string };

export interface ShellTerminalEngineOptions {
  resolveHost: (sessionId: string) => TerminalHostResolution;
  settings: () => { shell?: string; maxLive?: number };
  /** Injected by tests; node-pty in production. */
  spawn?: typeof pty.spawn;
  env?: NodeJS.ProcessEnv;
}

/**
 * The gateway's environment is not the operator's: the service unit loads every
 * credential in secrets/ into it, and a session's JINN_* identity rides along.
 * A shell gets only what a login needs to rebuild its own environment.
 */
const PASSTHROUGH_ENV = [
  "HOME", "USER", "LOGNAME", "SHELL", "PATH", "LANG", "LANGUAGE", "TZ",
  "SSH_AUTH_SOCK", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "DISPLAY", "WAYLAND_DISPLAY",
];

export function terminalEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (PASSTHROUGH_ENV.includes(key) || key.startsWith("LC_")) env[key] = value;
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  return env;
}

/** argv for a terminal on `host`, as `[file, args]`. */
export function terminalCommand(host: TerminalHost, shell: string): [string, string[]] {
  if (host.kind === "local") return [shell, ["-l"]];
  // An interactive human session, so ssh may prompt (host key, password) —
  // unlike the agent spawns, which are BatchMode. EscapeChar=none keeps a paste
  // containing "~." from dropping the connection.
  // The remote login shell parses this line, and it may be fish or nu, which
  // reject `${…}` and `||`. So it only runs POSIX sh, which does the rest; the
  // cwd arrives as $1, never inside the script.
  const remoteCommand = host.cwd
    ? [`exec /bin/sh -c ${shq('cd "$1" 2>/dev/null || cd; exec "${SHELL:-/bin/sh}" -l')} sh ${shq(host.cwd)}`]
    : [];
  const ssh = [
    resolveBin("ssh"),
    "-tt",
    "-o", "EscapeChar=none",
    "-o", "ConnectTimeout=15",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    // Before the destination: a host beginning with `-` must not be read as an
    // option. Hosts are charset-validated too (terminals/hosts.ts).
    "--",
    host.destination!,
    ...remoteCommand,
  ];
  // A banner first, so a slow or unreachable host shows something at once
  // rather than a blank terminal until ssh gives up. The label is an argument,
  // never part of the script.
  return ["/bin/sh", ["-c", 'printf "\\033[2mConnecting to %s…\\033[0m\\r\\n" "$0"; exec "$@"', host.label, ...ssh]];
}

interface LiveShell {
  proc: pty.IPty;
}

/**
 * Terminal snapshots live in memory only. An operator shell's scrollback can
 * hold anything the operator printed, from hosts no agent can reach, and the
 * disk store sits in the instance home every agent can read. A snapshot is
 * worth nothing across a gateway restart anyway: the shell died with it.
 */
class MemorySnapshotStore implements PtySnapshotPersistence {
  private readonly snapshots = new Map<string, SerializedPtySnapshot>();
  /** Deleted sessions. A capture already in flight when the session was
   *  forgotten (a shell that exited just before the delete) lands here and is
   *  dropped rather than kept for a session nobody can reach. */
  private readonly forgotten = new Map<string, true>();
  async load(sessionId: string): Promise<SerializedPtySnapshot | undefined> { return this.snapshots.get(sessionId); }
  schedule(sessionId: string, snapshot: SerializedPtySnapshot): void {
    if (!this.forgotten.has(sessionId)) setCapped(this.snapshots, sessionId, snapshot, STREAM_MAP_CAP);
  }
  async flush(): Promise<void> {}
  delete(sessionId: string): void {
    this.snapshots.delete(sessionId);
    setCapped(this.forgotten, sessionId, true);
  }
}

/**
 * Operator shells behind `/ws/pty/:sessionId`. Implements the same
 * contract as the interactive agent engines, so pty-ws.ts and the web terminal
 * serve it unchanged: the first `resize` spawns the shell, snapshots restore it
 * on reconnect, and every viewer sees the same PTY.
 *
 * A shell outlives its viewers — closing the pane is not `exit` — and ends when
 * it exits, when its session is deleted, or when the gateway stops.
 */
export class ShellTerminalEngine implements PtyViewEngine {
  private readonly live = new Map<string, LiveShell>();
  /** Shells that exited on their own, kept down until an explicit restart. */
  private readonly exited = new Map<string, PtyControlEvent>();
  private readonly snapshots = new MemorySnapshotStore();
  private readonly streams: PtyStreamManager;
  private readonly spawnPty: typeof pty.spawn;

  constructor(private readonly options: ShellTerminalEngineOptions) {
    this.streams = new PtyStreamManager("terminal", (id) => this.live.has(id), { snapshotStore: this.snapshots });
    this.spawnPty = options.spawn ?? pty.spawn;
  }

  hasWarmPty(sessionId: string): boolean {
    return this.live.has(sessionId);
  }

  ensureIdleSpawn(sessionId: string, opts: PtyIdleSpawnOpts): void {
    if (this.live.has(sessionId) || this.exited.has(sessionId)) return;
    this.assertCapacity();
    const resolved = this.options.resolveHost(sessionId);
    if ("error" in resolved) throw new Error(resolved.error);
    const proc = this.spawnFor(resolved.host, opts);
    this.live.set(sessionId, { proc });
    logger.info(`Terminal ${sessionId} opened on ${resolved.host.destination ?? "the gateway"} (pid ${proc.pid})`);
    this.streams.attach(sessionId, proc);
    proc.onExit(({ exitCode, signal }) => {
      if (this.live.get(sessionId)?.proc !== proc) return;
      this.live.delete(sessionId);
      setCapped(this.exited, sessionId, { type: "exited", exitCode, signal: signal ?? 0 });
      this.streams.onPtyExit(sessionId, { exitCode, signal });
    });
  }

  exitNotice(sessionId: string): PtyControlEvent | undefined {
    return this.live.has(sessionId) ? undefined : this.exited.get(sessionId);
  }

  private assertCapacity(): void {
    const maxLive = positive(this.options.settings().maxLive) ?? DEFAULT_MAX_LIVE_TERMINALS;
    if (this.live.size >= maxLive) {
      throw new Error(`${this.live.size} terminals are already open (terminal.maxLive is ${maxLive}) — close one first`);
    }
  }

  private spawnFor(host: TerminalHost, opts: PtyIdleSpawnOpts): pty.IPty {
    const env = terminalEnv(this.options.env ?? process.env);
    const configured = this.options.settings().shell;
    const shell = (typeof configured === "string" && configured.trim()) || env.SHELL || "/bin/sh";
    const [file, args] = terminalCommand(host, shell);
    return this.spawnPty(file, args, {
      name: "xterm-256color",
      cols: opts.cols ?? 120,
      rows: opts.rows ?? 40,
      cwd: env.HOME || os.homedir(),
      env,
    });
  }

  restartPty(sessionId: string, opts: PtyIdleSpawnOpts): void {
    // Quietly: the respawn below announces `restoring` itself, and an `exited`
    // in between would flash the exit notice at every viewer.
    // If the new shell cannot start (maxLive, a spawn error), the terminal must
    // stay exited, or the next resize would quietly spawn it after all.
    const previous = this.exited.get(sessionId) ?? { type: "exited", exitCode: 0, signal: 1 };
    this.stop(sessionId);
    this.exited.delete(sessionId);
    try {
      this.ensureIdleSpawn(sessionId, opts);
    } catch (error) {
      setCapped(this.exited, sessionId, previous);
      throw error;
    }
  }

  subscribeWithSnapshot(
    sessionId: string,
    cb: (data: Buffer) => void,
    onControl?: (event: PtyControlEvent) => void,
  ): PtySnapshotSubscription {
    return this.streams.subscribeWithSnapshot(sessionId, cb, onControl);
  }

  /** Viewers do not keep a shell alive or let it die; nothing to track. */
  setViewing(): void {}

  writeStdin(sessionId: string, text: string): void {
    this.live.get(sessionId)?.proc.write(text);
  }

  writeRaw(sessionId: string, data: string): void {
    this.live.get(sessionId)?.proc.write(data);
  }

  resizePty(sessionId: string, cols: number, rows: number): void {
    const shell = this.live.get(sessionId);
    if (!shell) return;
    shell.proc.resize(cols, rows);
    this.streams.resize(sessionId, cols, rows);
  }

  /** The session is gone: end its shell and keep nothing of its screen. Any
   *  other tab/device still watching this terminal gets a plain,
   *  not-recoverable notice before its stream disappears, instead of finding
   *  out only when its next resize fails with "Not a terminal session." */
  forget(sessionId: string): void {
    this.stop(sessionId);
    this.exited.delete(sessionId);
    this.snapshots.delete(sessionId);
    this.streams.discard(sessionId, {
      type: "error",
      message: "This terminal was deleted.",
      recoverable: false,
    });
  }

  killAll(): void {
    for (const sessionId of [...this.live.keys()]) this.forget(sessionId);
  }

  /** End a live shell without announcing it; its exit handler sees it is no
   *  longer the live one and stays quiet too. */
  private stop(sessionId: string): void {
    const shell = this.live.get(sessionId);
    if (!shell) return;
    this.live.delete(sessionId);
    try { shell.proc.kill(); } catch { /* already gone */ }
  }

  liveCount(): number {
    return this.live.size;
  }
}

function positive(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/**
 * The gateway's engine: a terminal session's host is its `sourceRef`, looked up
 * against the live config on every spawn, so a host the operator removed or
 * disabled stops opening rather than opening somewhere stale.
 */
export function createShellTerminalEngine(deps: {
  getConfig: () => JinnConfig;
  getSession: (sessionId: string) => Session | undefined;
  employees: (config: JinnConfig) => Iterable<Employee>;
}): ShellTerminalEngine {
  return new ShellTerminalEngine({
    settings: () => {
      const block = deps.getConfig().terminal as unknown;
      return block && typeof block === "object" && !Array.isArray(block) ? block as { shell?: string; maxLive?: number } : {};
    },
    resolveHost: (sessionId) => {
      const session = deps.getSession(sessionId);
      if (!session || !isTerminalSession(session)) return { error: "Not a terminal session." };
      const config = deps.getConfig();
      const list = listTerminalHosts(config, deps.employees(config));
      if (!list.enabled) return { error: list.disabledReason ?? "Terminals are off." };
      const host = findTerminalHost(list, session.sourceRef);
      return host ? { host } : { error: `Terminal host "${session.sourceRef}" is no longer configured.` };
    },
  });
}
