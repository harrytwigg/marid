import type { IncomingMessage, ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { logger } from "../shared/logger.js";
import type { JinnConfig } from "../shared/types.js";
import { appendPluginEvent } from "./event-log.js";
import { fileStamp } from "./file-stamp.js";
import { createPluginHost, type PluginHost } from "./host/index.js";
import { pluginStorage, type PluginStorage } from "./storage.js";

/** One backend route. `req` and `res` are the gateway's own, unwrapped. */
export type PluginRouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

/** What a registrar returns: `"GET /ping"` → handler. A map rather than a router
 *  object, because path parameters are not something a plugin needs yet and a
 *  matcher nobody uses is a matcher nobody has tested. */
export type PluginRoutes = Record<string, PluginRouteHandler>;

/** The context a plugin's `server.js` receives. */
export interface PluginServerContext {
  id: string;
  log: (message: string) => void;
  storage: PluginStorage;
  /** The typed verb door: Todos, a scoped session spawn, the org,
   *  notes, a connector send, cron reads, knowledge search, and a dashboard
   *  notice. The same object the plugin's registrar gets is the one its watcher
   *  starts with, so a background task and a route act as one plugin rather
   *  than as two with the same id. */
  host: PluginHost;
  /** Append an event to this plugin's ring, readable at `/api/plugins/<id>/events`
   *  by polling and over that path's socket. Bounded and in memory — the channel
   *  a live UI watches, not a record to depend on. */
  emit: (event: unknown) => void;
  /** This plugin's slice of `config.plugins.settings`. A getter, not a snapshot —
   *  see {@link pluginSettings}. */
  readonly settings: Record<string, unknown>;
}

/**
 * A plugin's optional background task, named export `watcher` on `server.js`.
 *
 * The vocabulary is deliberately `Connector`'s (shared/types.ts) — `start`,
 * `stop`, and health readable by id — so a reader who knows connectors knows
 * this. The gateway owns when each is called: importing the module must never
 * start anything, which is why `start` is not module evaluation.
 *
 * The promise `start` returns is the watcher's lifetime, not merely its setup.
 * A task that fails long after starting rejects it, and that is how the
 * supervisor learns to restart it.
 */
export interface PluginWatcher {
  start(context: PluginServerContext): void | Promise<void>;
  stop(): void | Promise<void>;
}

type PluginRegistrar = (context: PluginServerContext) => PluginRoutes | Promise<PluginRoutes>;

export type PluginDispatch =
  | { outcome: "handled" }
  | { outcome: "no-route" }
  /** The plugin failed. `message` is the gateway's own wording — a third party's
   *  error text and stack stay in the log, not on the wire. */
  | { outcome: "failed"; message: string };

/** What it takes to load a plugin's server module, with nothing about a request
 *  in it — the supervisor loads the same module the request path does. */
export interface PluginBackendRequest {
  id: string;
  /** Absolute path to the plugin's server entry. */
  server: string;
  readSettings: () => Record<string, unknown>;
}

export interface PluginDispatchRequest extends PluginBackendRequest {
  method: string;
  /** The path below `/api/plugins/<id>/`, without a leading slash. */
  tail: string;
}

/** One live incarnation of one plugin's server module. The routes, the watcher
 *  and the context all come from a single import, so the process never holds two
 *  copies of a plugin disagreeing about its own state. */
export interface LoadedBackend {
  version: string;
  routes: PluginRoutes;
  watcher: PluginWatcher | null;
  context: PluginServerContext;
}

/** One version of one file loaded, or null when that version failed to import or
 *  to register. Failure is cached too: a plugin whose module throws must not be
 *  re-imported on every request until its author fixes it. */
interface BackendEntry {
  version: string;
  backend: LoadedBackend | null;
}

const entries = new Map<string, BackendEntry>();

/** How many times a plugin's backend has been disposed. It joins the import
 *  specifier because dropping our own entry is not enough: Node keeps its module
 *  cache keyed on the specifier, so an unchanged file re-enabled under the same
 *  one hands back the very incarnation the operator turned off. Each generation
 *  leaves its predecessor in that cache, exactly as every file edit already does
 *  — the accepted cost of hot-reloading ESM, which offers no way to evict. */
const generations = new Map<string, number>();

/**
 * The plugin's slice of `config.plugins.settings`, `{}` when the operator has
 * written none. Read through the context's getter rather than captured at import
 * time, so editing `config.yaml` reaches a registrar that loaded before the edit.
 */
export function pluginSettings(id: string, config: Pick<JinnConfig, "plugins">): Record<string, unknown> {
  const settings = config.plugins?.settings?.[id];
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return {};
  return settings;
}

function makeContext(id: string, readSettings: () => Record<string, unknown>): PluginServerContext {
  return {
    id,
    log: (message) => logger.info(`[plugin:${id}] ${message}`),
    storage: pluginStorage(id),
    host: createPluginHost(id),
    emit: (event) => appendPluginEvent(id, event),
    get settings() {
      return readSettings();
    },
  };
}

/** The module's `watcher` export, or null when it has none. A malformed one is a
 *  load failure rather than a background task nobody supervises. */
function readWatcher(exported: unknown, server: string): PluginWatcher | null {
  if (exported === undefined) return null;
  const watcher = exported as Partial<PluginWatcher> | null;
  if (!watcher || typeof watcher.start !== "function" || typeof watcher.stop !== "function") {
    throw new TypeError(`${server} must export "watcher" as { start(context), stop() } or not at all`);
  }
  return watcher as PluginWatcher;
}

/** Import the server entry and call its registrar. Throws on anything the plugin
 *  gets wrong; {@link loadBackend} is what turns that into a cached failure. */
async function register(request: PluginBackendRequest, version: string): Promise<LoadedBackend> {
  // The query is what defeats the ESM module cache: same path, new specifier, so
  // an edited file — or a plugin disposed and enabled again — is re-evaluated
  // without a gateway restart or a plugin rescan.
  const specifier = `${pathToFileURL(request.server).href}?v=${encodeURIComponent(version)}`;
  const module = (await import(specifier)) as { default?: unknown; watcher?: unknown };
  if (typeof module.default !== "function") {
    throw new TypeError(`${request.server} must default-export a function that returns routes`);
  }
  // Read before the registrar runs: a plugin that declares a watcher it got wrong
  // should fail to load rather than register routes and then be refused.
  const watcher = readWatcher(module.watcher, request.server);
  const context = makeContext(request.id, request.readSettings);
  const routes = await (module.default as PluginRegistrar)(context);
  if (!routes || typeof routes !== "object") {
    throw new TypeError(`${request.server} registrar must return an object of "METHOD /path" routes`);
  }
  return { version, routes, watcher, context };
}

/** A manifest may declare a `server` entry that is not on disk — discovery keeps
 *  the plugin loaded and lets its client half run — so "no file" is a route that
 *  does not exist, not a plugin that broke. */
type LoadResult = { ok: true; backend: LoadedBackend } | { ok: false; reason: "missing" | "failed" };

/** One load in flight per plugin. Without it, a request and the watcher
 *  supervisor arriving together both miss the cache and both call the registrar —
 *  running a plugin's setup twice and leaving the process with two contexts for
 *  one plugin. */
const loading = new Map<string, { version: string; result: Promise<LoadResult> }>();

async function registerEntry(request: PluginBackendRequest, version: string): Promise<LoadResult> {
  try {
    const backend = await register(request, version);
    entries.set(request.id, { version, backend });
    return { ok: true, backend };
  } catch (err) {
    entries.set(request.id, { version, backend: null });
    logger.error(`Plugin "${request.id}" failed to load: ${err instanceof Error ? err.stack ?? err.message : err}`);
    return { ok: false, reason: "failed" };
  }
}

/** This plugin's server module as it stands right now. */
async function loadBackend(request: PluginBackendRequest): Promise<LoadResult> {
  const stamp = await fileStamp(request.server);
  if (stamp === null) {
    entries.delete(request.id);
    return { ok: false, reason: "missing" };
  }
  const version = `${generations.get(request.id) ?? 0}:${stamp}`;
  const cached = entries.get(request.id);
  if (cached?.version === version) {
    return cached.backend ? { ok: true, backend: cached.backend } : { ok: false, reason: "failed" };
  }
  // A load already running for this exact version is the one to wait on. An
  // older one is not: its version was superseded while it ran.
  const inFlight = loading.get(request.id);
  if (inFlight?.version === version) return inFlight.result;

  const pending = registerEntry(request, version);
  loading.set(request.id, { version, result: pending });
  try {
    return await pending;
  } finally {
    if (loading.get(request.id)?.result === pending) loading.delete(request.id);
  }
}

/** This plugin's loaded module, or null when its server entry is absent or
 *  broken. The supervisor reads it through here so that the watcher it starts and
 *  the routes a request reaches are the same incarnation. */
export async function loadPluginBackend(request: PluginBackendRequest): Promise<LoadedBackend | null> {
  const loaded = await loadBackend(request);
  return loaded.ok ? loaded.backend : null;
}

/**
 * Run one request against a plugin's own routes.
 *
 * Every call into third-party code — the registrar and the handler alike — is
 * wrapped, because a plugin failing is an expected event and the gateway serves
 * every other request through the same process. An escaping throw would answer
 * with the plugin's own error text; an unawaited rejection would reach the
 * process as an unhandled rejection. Both stop here, at this plugin's request.
 */
export async function dispatchPluginRequest(
  req: IncomingMessage,
  res: ServerResponse,
  request: PluginDispatchRequest,
): Promise<PluginDispatch> {
  const loaded = await loadBackend(request);
  if (!loaded.ok) {
    if (loaded.reason === "missing") return { outcome: "no-route" };
    return { outcome: "failed", message: `plugin "${request.id}" failed to load` };
  }

  const handler = loaded.backend.routes[`${request.method} /${request.tail}`];
  if (typeof handler !== "function") return { outcome: "no-route" };

  try {
    await handler(req, res);
    return { outcome: "handled" };
  } catch (err) {
    logger.error(
      `Plugin "${request.id}" failed on ${request.method} /${request.tail}: ` +
        `${err instanceof Error ? err.stack ?? err.message : err}`,
    );
    return { outcome: "failed", message: `plugin "${request.id}" failed to handle the request` };
  }
}

/** Forget a plugin's registrar. Called when it stops being servable, so
 *  re-enabling it imports the module again rather than resurrecting the
 *  incarnation that was running when the operator turned it off. */
export function disposePluginBackend(id: string): void {
  entries.delete(id);
  generations.set(id, (generations.get(id) ?? 0) + 1);
}

/** Forget every loaded backend whose plugin is no longer servable. The request
 *  path disposes lazily, on the first request that finds a plugin disabled — and
 *  that request never arrives when the operator disables and re-enables in one
 *  sitting, which would leave the plugin answering from the incarnation they
 *  turned off. */
export function disposeUnservableBackends(isServable: (id: string) => boolean): void {
  for (const id of [...entries.keys()]) {
    if (!isServable(id)) disposePluginBackend(id);
  }
}
