import { logger } from "../shared/logger.js";
import type { HundredfoldConfig } from "../shared/types.js";
import { loadPluginBackend, pluginSettings, type PluginServerContext, type PluginWatcher } from "./backend.js";
import { loadPlugin } from "./discovery.js";
import { isPluginEnabled } from "./enablement.js";

/**
 * The gateway's ownership of a plugin's background task.
 *
 * A plugin never starts or stops its own watcher: it exports one, and this
 * decides when it runs. Everything a third party's code can do to the process —
 * throw on start, fail an hour later, refuse to stop — is absorbed here, because
 * the gateway serves every other plugin and every session from the same process.
 */

/** How long `stop()` gets before the gateway stops waiting on it. Shutdown has
 *  to finish whether or not a plugin cooperates. */
export const WATCHER_STOP_TIMEOUT_MS = 5_000;

/** The first wait after a crash. Each subsequent restart doubles it. */
export const WATCHER_RESTART_BASE_MS = 1_000;

/** Restarts before the supervisor gives up for good. Past this the watcher stays
 *  down and its health says so: a watcher that silently quit is worse than one
 *  that is visibly dead. */
export const WATCHER_MAX_RESTARTS = 5;

/** The `ConnectorHealth` vocabulary (shared/types.ts), plus the restart count
 *  that is the whole point of supervising. `qr_pending` has no meaning here. */
export interface PluginWatcherHealth {
  status: "running" | "stopped" | "error";
  detail?: string;
  restarts: number;
}

/** One version of one plugin's watcher, as loaded from its server module. */
export interface PluginWatcherIncarnation {
  version: string;
  watcher: PluginWatcher;
  context: PluginServerContext;
}

interface Supervised extends PluginWatcherIncarnation {
  status: PluginWatcherHealth["status"];
  detail?: string;
  restarts: number;
  retry: ReturnType<typeof setTimeout> | null;
}

/** Only ever holds watchers the gateway means to be running. A stop removes the
 *  entry, which is also how a late failure from a released incarnation is
 *  recognised as stale: its entry is no longer the one under its id. */
const supervised = new Map<string, Supervised>();

/** The health of a watcher the gateway has stopped. Kept, because "stopped" is a
 *  state an operator has to be able to read: a plugin whose watcher was running a
 *  moment ago and is not now says so, while a plugin that never had one still
 *  reports nothing at all. */
const stoppedHealth = new Map<string, PluginWatcherHealth>();

/** Bumped by every `stopAllPluginWatchers`. A reconcile already in flight at
 *  shutdown still has a third-party module to finish importing, and this is what
 *  keeps it from starting a watcher into a gateway that is gone. */
let stopGeneration = 0;

/**
 * Call `start()` and stay attached to whatever it returns.
 *
 * The returned promise is the watcher's lifetime, not its setup, so the handler
 * here is what catches a task that fails long after it started — and, because
 * the handler exists at all, what keeps that rejection off the process.
 */
function beginStart(id: string, entry: Supervised): void {
  try {
    const started = entry.watcher.start(entry.context);
    entry.status = "running";
    entry.detail = undefined;
    void Promise.resolve(started).catch((err) => handleCrash(id, entry, err));
  } catch (err) {
    handleCrash(id, entry, err);
  }
}

/** Schedule the next attempt, or stop trying and say why. */
function handleCrash(id: string, entry: Supervised, err: unknown): void {
  // A watcher the supervisor has already let go: its entry is gone, or a newer
  // incarnation took its id. Either way this failure is nobody's to act on.
  if (supervised.get(id) !== entry) return;

  const reason = err instanceof Error ? err.message : String(err);
  logger.error(`Plugin "${id}" watcher failed: ${err instanceof Error ? err.stack ?? reason : reason}`);
  entry.status = "error";

  if (entry.restarts >= WATCHER_MAX_RESTARTS) {
    entry.detail = `stayed down after ${WATCHER_MAX_RESTARTS} restarts: ${reason}`;
    return;
  }
  // Counted for the lifetime of the incarnation rather than reset on a good run,
  // so a watcher that crashes and recovers forever still reaches the cap and
  // becomes visible instead of restarting quietly until someone notices.
  const delay = WATCHER_RESTART_BASE_MS * 2 ** entry.restarts;
  entry.restarts++;
  entry.detail = `restart ${entry.restarts} of ${WATCHER_MAX_RESTARTS} in ${delay}ms: ${reason}`;
  entry.retry = setTimeout(() => {
    entry.retry = null;
    if (supervised.get(id) !== entry) return;
    beginStart(id, entry);
  }, delay);
  entry.retry.unref?.();
}

/**
 * `stop()` with a deadline. A watcher that will not stop is logged and
 * abandoned: the gateway carries on, and process exit is what finally reclaims
 * whatever it was holding.
 */
async function stopWithTimeout(id: string, watcher: PluginWatcher): Promise<void> {
  // Wrapped so a synchronous throw from stop() arrives as a rejection like any
  // other, rather than escaping past the race below.
  const stopped = (async () => watcher.stop())().catch((err) => {
    logger.error(`Plugin "${id}" watcher failed to stop: ${err instanceof Error ? err.stack ?? err.message : err}`);
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), WATCHER_STOP_TIMEOUT_MS);
    timer.unref?.();
  });

  const outcome = await Promise.race([stopped.then(() => "stopped" as const), deadline]);
  clearTimeout(timer);
  if (outcome === "timeout") {
    logger.warn(`Plugin "${id}" watcher ignored stop() for ${WATCHER_STOP_TIMEOUT_MS}ms; abandoning it`);
  }
}

/** Supervise this incarnation of a plugin's watcher. Starting the incarnation
 *  that is already running is a no-op; a different one replaces it, old stopped
 *  before new started. */
export async function startPluginWatcher(id: string, incarnation: PluginWatcherIncarnation): Promise<void> {
  if (supervised.get(id)?.version === incarnation.version) return;
  const generation = stopGeneration;
  await stopPluginWatcher(id);
  // Stopping the old incarnation is allowed to take its whole deadline, and the
  // gateway may shut down inside it. Nothing new starts after that.
  if (stopGeneration !== generation) return;

  const entry: Supervised = { ...incarnation, status: "stopped", restarts: 0, retry: null };
  supervised.set(id, entry);
  stoppedHealth.delete(id);
  beginStart(id, entry);
}

/** Stop a plugin's watcher and forget it. Safe to call for a plugin that has none. */
export async function stopPluginWatcher(id: string): Promise<void> {
  const entry = supervised.get(id);
  if (!entry) return;
  supervised.delete(id);
  stoppedHealth.set(id, { status: "stopped", restarts: entry.restarts });
  if (entry.retry) clearTimeout(entry.retry);
  await stopWithTimeout(id, entry.watcher);
}

/** Every watcher stopped, for gateway shutdown. One that hangs delays the others
 *  by nothing: each carries its own deadline. */
export async function stopAllPluginWatchers(): Promise<void> {
  stopGeneration++;
  await Promise.all([...supervised.keys()].map((id) => stopPluginWatcher(id)));
}

/** How a plugin's watcher is doing, or null when the gateway has never run one
 *  for it — which is not the same as one that is stopped, and does not answer as
 *  if it were. */
export function pluginWatcherHealth(id: string): PluginWatcherHealth | null {
  const entry = supervised.get(id);
  if (!entry) return stoppedHealth.get(id) ?? null;
  return { status: entry.status, ...(entry.detail ? { detail: entry.detail } : {}), restarts: entry.restarts };
}

type PluginConfig = Pick<HundredfoldConfig, "plugins">;

/**
 * The plugins whose watchers should be running: enabled, installed, and carrying
 * a server entry.
 *
 * Read one id at a time from the operator's own list rather than from
 * `scanPlugins`, which shares one in-flight read between concurrent callers — a
 * request is entitled to a scan taken at its own moment, and reconciling is not
 * a reason to hand it one taken at ours. Enablement is opt-in, so the list is the
 * complete set of candidates.
 */
async function watchedPlugins(config: PluginConfig): Promise<Map<string, string>> {
  const enabled = config.plugins?.enabled;
  const names = Array.isArray(enabled) ? enabled.filter((name): name is string => typeof name === "string") : [];
  const servers = new Map<string, string>();
  for (const name of new Set(names)) {
    if (!isPluginEnabled(name, config)) continue;
    const plugin = await loadPlugin(name);
    // Keyed by the manifest's id, the one the inventory row and the request path
    // both use, so health looked up per row finds it.
    if (plugin?.status === "loaded" && plugin.server) servers.set(plugin.id, plugin.server);
  }
  return servers;
}

async function runReconcile(getConfig: () => PluginConfig): Promise<void> {
  const generation = stopGeneration;
  const wanted = await watchedPlugins(getConfig());
  if (stopGeneration !== generation) return;

  for (const id of [...supervised.keys()]) {
    if (!wanted.has(id)) await stopPluginWatcher(id);
  }

  for (const [id, server] of wanted) {
    // Loading is what reveals whether there is a watcher at all, and it goes
    // through the same cache the request path uses, so the watcher started here
    // belongs to the incarnation that answers requests.
    const backend = await loadPluginBackend({
      id,
      server,
      readSettings: () => pluginSettings(id, getConfig()),
    });
    // Importing a plugin's module is the slowest thing here, and the gateway can
    // shut down while it runs. What it exports is no longer wanted by the time it
    // arrives: starting it now would outlive the process that asked for it.
    if (stopGeneration !== generation) return;
    if (!backend?.watcher) {
      await stopPluginWatcher(id);
      // A plugin that no longer exports a watcher has none, rather than a stopped
      // one, so the record of the incarnation that did goes with it.
      stoppedHealth.delete(id);
      continue;
    }
    await startPluginWatcher(id, {
      version: backend.version,
      watcher: backend.watcher,
      context: backend.context,
    });
  }
}

let reconciling: Promise<void> | null = null;
let reconcileAgain = false;

/**
 * Bring the running watchers in line with what `config.yaml` and the plugins
 * directory now say — the one entry point for boot, for a config reload and for
 * an edit on disk.
 *
 * Calls do not overlap. A request that arrives mid-pass sets a flag and the pass
 * repeats, because a reconcile racing itself would import one plugin twice and
 * leave two watchers under one id. The repeat does not survive a shutdown: what
 * that request wanted reconciled is exactly what shutdown just took down.
 */
export function reconcilePluginWatchers(getConfig: () => PluginConfig): Promise<void> {
  if (reconciling) {
    reconcileAgain = true;
    return reconciling;
  }
  reconciling = (async () => {
    // Held across the whole sequence, not per pass: a queued request predates the
    // shutdown, so starting its pass afterwards would start a watcher the gateway
    // has already stopped waiting for.
    const generation = stopGeneration;
    do {
      reconcileAgain = false;
      await runReconcile(getConfig);
    } while (reconcileAgain && stopGeneration === generation);
  })()
    .catch((err) => logger.error(`Plugin watcher reconcile failed: ${err instanceof Error ? err.message : err}`))
    .finally(() => {
      reconciling = null;
    });
  return reconciling;
}
