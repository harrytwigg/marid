import type { IPty } from "node-pty";
/**
 * PTY lifecycle for interactive CLI/xterm engines.
 *
 * Rules:
 *   - A PTY is not reaped because it is old. Native agent loops can legitimately
 *     sit idle for days and wake themselves later.
 *   - maxLivePtys is an IDLE warm-PTY cap. Running turns and actively viewed
 *     terminals are never counted against it or killed to satisfy it.
 *   - The cap is per host. `maxLivePtys` bounds the gateway's own processes;
 *     a remote host's idle processes are counted against that host alone
 *     (`maxLivePtysByHost`, else `maxLivePtys` again), so they never use up the
 *     gateway host's budget. A process whose pool applies its own per-host cap
 *     (opencode servers on a remote host) is left out of this one.
 *   - When a host's idle cap is exceeded, its stalest idle/unviewed PTY is released.
 */

/** The host key of the gateway itself. A remote host's key is the employee's
 *  `remoteHost` exactly as written, the same keys `maxIdleByHost` uses. */
export const LOCAL_HOST_KEY = "local";

/** The idle-cap host key for a session's target: `local`, or its `remoteHost`. */
export function ptyHostKey(target: { remoteHost?: string } | undefined): string {
  const host = target?.remoteHost;
  return typeof host === "string" && host.trim().length > 0 ? host : LOCAL_HOST_KEY;
}

/** The idle PTY cap for one host: `maxLivePtys` for the gateway, and for a
 *  remote host its `maxLivePtysByHost` entry, else `maxLivePtys` again. */
export function ptyIdleCapForHost(
  cfg: { maxLivePtys?: number; maxLivePtysByHost?: Record<string, number> },
  hostKey: string,
): number {
  const base = typeof cfg.maxLivePtys === "number" ? cfg.maxLivePtys : DEFAULT_MAX_LIVE_PTYS;
  const byHost = hostKey === LOCAL_HOST_KEY ? undefined : cfg.maxLivePtysByHost?.[hostKey];
  const cap = typeof byHost === "number" ? byHost : base;
  return Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) : DEFAULT_MAX_LIVE_PTYS;
}

export const DEFAULT_MAX_LIVE_PTYS = 8;

export interface PtyHandle {
  pid: number;
  killed: boolean;
  kill: (signal?: string) => void;
}

/** What node-pty reports when a PTY's process goes away. The claude watchdog path
 *  only ever sees an exit code, so both halves are optional. */
export interface PtyExit {
  exitCode?: number | null;
  signal?: number | null;
}

/**
 * Why a turn ended when the PTY process it was talking to went away.
 *
 * Lives beside `PtyHandle` because all four interactive engines settle their
 * active turn with one of these and have to agree on the shape. Two rules bind it:
 * it must keep starting with `Interrupted`, because `wasQuietlyPreempted`
 * (sessions/turn/runner.ts) reads that prefix to settle the turn silently rather
 * than report a failure nobody caused; and everything after the sentence is
 * diagnostics, because a bare "claude process exited" was the entire account an
 * 82-minute session got of why it ended.
 */
export function processExitInterruption(engine: string, exit?: PtyExit): string {
  return `Interrupted: ${engine} process exited (code ${exit?.exitCode ?? "unknown"}, signal ${exit?.signal ?? "unknown"})`;
}

/** Whether an interruption reason is one of the above. A prefix test rather than an
 *  equality one, because the sentence now carries per-exit diagnostics after it. */
export function isProcessExitInterruption(reason: string): boolean {
  return /^Interrupted: \S+ process exited\b/.test(reason);
}

export interface PtyLifecycleOpts {
  maxLivePtys: number;
  /** Called after a new PTY session is adopted — used to refresh gateway.json pids. */
  onAdopt?: (sessionId: string) => void;
  /** Called after a PTY is killed/removed — used to clean the --settings file, hook registry, gateway.json pids. */
  onCleanup?: (sessionId: string) => void;
  /** Called after adoption or state changes may have changed global idle-cap pressure. */
  onIdleStateChange?: () => void;
  /** Default true. Server-managed lifecycles disable this and enforce one global cap. */
  enforceLocalCap?: boolean;
}

export interface PtyAdoptState {
  /** Set for cold spawns that are immediately serving a turn. */
  turnRunning?: boolean;
  /** Optional initial viewer count for a terminal-born PTY. */
  viewerCount?: number;
  /** Where the process runs: {@link LOCAL_HOST_KEY} (default) or a `remoteHost`. */
  hostKey?: string;
  /** The owning pool bounds this process itself, so the idle PTY cap leaves it out. */
  selfCapped?: boolean;
}

interface Entry {
  handle: PtyHandle;
  turnRunning: boolean;
  runtimeActive: boolean;
  viewerCount: number;
  viewingEndedAt: number; // epoch ms; 0 while at least one viewer is attached
  lastTurnEndedAt: number; // epoch ms; 0 if no turn has completed yet
  hostKey: string;
  selfCapped: boolean;
}

export interface PtyIdleCandidate {
  manager: PtyLifecycleManager;
  sessionId: string;
  idleSince: number;
  hostKey: string;
  selfCapped: boolean;
}

/** Release the stalest idle PTYs on every host that is over its cap. A number
 *  caps each host at that many; a function gives each host its own cap. */
export function enforcePtyIdleCap(
  managers: PtyLifecycleManager[],
  maxIdlePtys: number | ((hostKey: string) => number),
): void {
  const capFor = typeof maxIdlePtys === "function" ? maxIdlePtys : () => maxIdlePtys;
  const byHost = new Map<string, PtyIdleCandidate[]>();
  for (const candidate of managers.flatMap((manager) => manager.idleCandidates())) {
    if (candidate.selfCapped) continue;
    const list = byHost.get(candidate.hostKey) ?? [];
    list.push(candidate);
    byHost.set(candidate.hostKey, list);
  }
  for (const [hostKey, list] of byHost) {
    const max = Math.max(0, capFor(hostKey));
    const stalestFirst = list.sort((a, b) => a.idleSince - b.idleSince);
    for (const victim of stalestFirst.slice(0, Math.max(0, stalestFirst.length - max))) {
      victim.manager.releaseSession(victim.sessionId);
    }
  }
}

export class PtyLifecycleManager {
  private entries = new Map<string, Entry>();
  private releaseListeners: Array<(sessionId: string) => void> = [];

  constructor(private opts: PtyLifecycleOpts) {}

  adopt(sessionId: string, handle: PtyHandle, state: PtyAdoptState = {}): void {
    const turnRunning = state.turnRunning === true;
    const viewerCount = Math.max(0, state.viewerCount ?? 0);
    this.entries.set(sessionId, {
      handle,
      turnRunning,
      runtimeActive: false,
      viewerCount,
      viewingEndedAt: viewerCount > 0 ? 0 : Date.now(),
      lastTurnEndedAt: turnRunning ? 0 : Date.now(),
      hostKey: state.hostKey ?? LOCAL_HOST_KEY,
      selfCapped: state.selfCapped === true,
    });
    this.opts.onAdopt?.(sessionId);
    this.enforceLocalIdleCap();
    this.opts.onIdleStateChange?.();
  }

  getWarm(sessionId: string): PtyHandle | undefined {
    return this.entries.get(sessionId)?.handle;
  }

  /** Whether the gateway's own idle PTYs have reached `maxLivePtys`. */
  isAtCapacity(): boolean {
    return this.idleWarmCount() >= this.opts.maxLivePtys;
  }

  livePids(): number[] {
    return [...this.entries.values()].map((e) => e.handle.pid);
  }

  viewerEnter(sessionId: string): void {
    const e = this.entries.get(sessionId);
    if (!e) return;
    e.viewerCount += 1;
    e.viewingEndedAt = 0;
  }

  viewerLeave(sessionId: string): void {
    const e = this.entries.get(sessionId);
    if (!e) return;
    e.viewerCount = Math.max(0, e.viewerCount - 1);
    if (e.viewerCount === 0) {
      e.viewingEndedAt = Date.now();
      this.enforceLocalIdleCap();
      this.opts.onIdleStateChange?.();
    }
  }

  turnStarted(sessionId: string): void {
    const e = this.entries.get(sessionId);
    if (e) e.turnRunning = true;
  }

  setRuntimeActive(sessionId: string, active: boolean): void {
    const e = this.entries.get(sessionId);
    if (!e || e.runtimeActive === active) return;
    e.runtimeActive = active;
    this.enforceLocalIdleCap();
    this.opts.onIdleStateChange?.();
  }

  turnEnded(sessionId: string): void {
    const e = this.entries.get(sessionId);
    if (!e) return;
    e.turnRunning = false;
    e.lastTurnEndedAt = Date.now();
    this.enforceLocalIdleCap();
    this.opts.onIdleStateChange?.();
  }

  /** Engine-side release hook: invoked for EVERY released session (manual release,
   *  LRU eviction, sweep reap, killAll), after the gateway's onCleanup. Engines use
   *  it to purge per-session bookkeeping (spawn params, output timestamps) so their
   *  maps don't grow forever in a long-running daemon. */
  onRelease(listener: (sessionId: string) => void): void {
    this.releaseListeners.push(listener);
  }

  releaseSession(sessionId: string): void {
    const e = this.entries.get(sessionId);
    if (!e) return;
    this.entries.delete(sessionId);
    if (!e.handle.killed) {
      e.handle.kill("SIGTERM");
      const forceKill = setTimeout(() => {
        if (!e.handle.killed) e.handle.kill("SIGKILL");
      }, 2000);
      forceKill.unref?.();
    }
    this.opts.onCleanup?.(sessionId);
    for (const l of this.releaseListeners) l(sessionId);
  }

  killAll(): void {
    for (const id of [...this.entries.keys()]) this.releaseSession(id);
  }

  /** Release only PTYs that are not serving foreground or native runtime work.
   *  A session is spared if its entry has `turnRunning` / `runtimeActive` set OR
   *  the caller's `isActive` predicate flags it (covers the cold-spawn window
   *  where the engine's active set is populated before `turnStarted` mirrors it). */
  releaseIdle(isActive: (sessionId: string) => boolean): void {
    for (const [id, e] of [...this.entries.entries()]) {
      if (e.turnRunning || e.runtimeActive || isActive(id)) continue;
      this.releaseSession(id);
    }
  }

  private idleWarmCount(): number {
    return this.idleCandidates().filter((c) => c.hostKey === LOCAL_HOST_KEY && !c.selfCapped).length;
  }

  idleCandidates(): PtyIdleCandidate[] {
    const candidates: PtyIdleCandidate[] = [];
    for (const [sessionId, e] of this.entries.entries()) {
      if (e.turnRunning || e.runtimeActive || e.viewerCount > 0) continue;
      candidates.push({
        manager: this,
        sessionId,
        idleSince: Math.max(e.viewingEndedAt, e.lastTurnEndedAt),
        hostKey: e.hostKey,
        selfCapped: e.selfCapped,
      });
    }
    return candidates;
  }

  private enforceLocalIdleCap(): void {
    if (this.opts.enforceLocalCap === false) return;
    enforcePtyIdleCap([this], this.opts.maxLivePtys);
  }

  dispose(): void {
    this.killAll();
  }
}

export function createPtyHandle(proc: IPty): PtyHandle {
  const handle = {
    pid: proc.pid,
    get killed() { return (proc as any)._exitCode != null; },
    kill: (signal?: string) => { try { proc.kill(signal); } catch { /* already gone */ } },
  } as PtyHandle;
  (handle as any)._proc = proc;
  return handle;
}
