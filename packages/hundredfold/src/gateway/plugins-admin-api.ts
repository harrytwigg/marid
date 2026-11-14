import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import yaml from "js-yaml";
import { disposeUnservableBackends } from "../plugins/backend.js";
import { loadPlugin } from "../plugins/discovery.js";
import { isPluginEnabled } from "../plugins/enablement.js";
import { PLUGIN_ID_PATTERN } from "../plugins/manifest.js";
import { reconcilePluginWatchers } from "../plugins/watcher-supervisor.js";
import { saveConfigAtomic } from "../shared/config.js";
import { logger } from "../shared/logger.js";
import { CONFIG_PATH } from "../shared/paths.js";
import { readJsonBody } from "./http-helpers.js";
import { json, matchRoute, notFound, serverError, type ParsedRoute } from "./route-helpers.js";
import type { ApiContext } from "./api.js";

/**
 * The routes that change a plugin's state rather than serve it: the operator's
 * enable decision, and revealing a plugin's folder.
 *
 * They live beside `plugins-api.ts` rather than in it because they belong to a
 * different caller. Everything in that file answers the dashboard's plugin
 * runtime; everything here answers the operator's settings page, is gated
 * operator-only in api.ts, and writes `config.yaml`.
 */

const ENABLED_ROUTE = "/api/plugins/:id/enabled";
const REVEAL_ROUTE = "/api/plugins/:id/reveal";
const RESCAN_PATH = "/api/plugins/rescan";

/**
 * What each plugin-admin route is called in api.ts's operator-authority table,
 * or null when this is not one of them.
 *
 * Exported so that table holds one line for the whole module: a route added
 * here cannot be added without its authority, which is the failure mode a
 * per-route line in a table of eighty invites.
 */
export function pluginAdminAction(method: string, pathname: string): string | null {
  if (method !== "POST") return null;
  if (pathname === RESCAN_PATH) return "plugin rescan";
  if (matchRoute(ENABLED_ROUTE, pathname)) return "plugin enable/disable";
  if (matchRoute(REVEAL_ROUTE, pathname)) return "plugin folder reveal";
  return null;
}

/** Names the operator wrote, ignoring anything in the list that is not one. */
function namesIn(list: unknown): string[] {
  return Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * The operator's two lists after one decision about one plugin.
 *
 * Enabling adds the id to `enabled` AND removes it from `disabled`, because
 * `disabled` wins (plugins/enablement.ts): leaving a stale entry there would
 * make an enable that appears to have worked do nothing at all. Disabling is the
 * inverse, and for the same reason — absence is not enabled, but an explicit
 * `disabled` entry is what survives a plugin being re-listed by something else.
 */
export function decidedLists(
  plugins: { enabled?: unknown; disabled?: unknown } | undefined,
  id: string,
  enabled: boolean,
): { enabled: string[]; disabled: string[] } {
  const without = (list: unknown) => namesIn(list).filter((name) => name !== id);
  return enabled
    ? { enabled: [...without(plugins?.enabled), id], disabled: without(plugins?.disabled) }
    : { enabled: without(plugins?.enabled), disabled: [...without(plugins?.disabled), id] };
}

/**
 * The work a change to the operator's lists or to the plugins directory implies,
 * which is exactly what the file watcher already does (gateway/watch-callbacks.ts):
 * a plugin that stopped being servable loses its loaded backend, and the running
 * watchers come back in line with what config now says.
 *
 * Awaited, unlike in the watcher, because a request that answers "rescanned" has
 * to have finished rescanning before it says so.
 */
export async function reconcilePluginRuntime(context: ApiContext): Promise<void> {
  const getConfig = () => context.getConfig();
  disposeUnservableBackends((id) => isPluginEnabled(id, getConfig()));
  await reconcilePluginWatchers(getConfig);
}

/** `config.yaml` as an object, or null when it is not one. A toggle is not worth
 *  rewriting a config we could not read: recreating it from scratch would take
 *  the operator's engines, connectors and tokens with it. Stricter than PUT
 *  /api/config on one point: a missing file is refused here too, because a plugin
 *  decision about a gateway with no config yet decides nothing. */
function readConfigFile(): Record<string, unknown> | null {
  let loaded: unknown;
  try {
    loaded = yaml.load(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return null;
  }
  return loaded && typeof loaded === "object" && !Array.isArray(loaded) ? (loaded as Record<string, unknown>) : null;
}

/** Record the operator's decision in `config.yaml` and make it true now. */
async function setPluginEnabled(
  req: HttpRequest,
  res: ServerResponse,
  id: string,
  context: ApiContext,
): Promise<void> {
  const parsed = await readJsonBody(req, res);
  if (!parsed.ok) return;
  const enabled = (parsed.body as { enabled?: unknown } | null)?.enabled;
  if (typeof enabled !== "boolean") return json(res, { error: "enabled must be a boolean" }, 400);
  // An id naming nothing installed gets the same 404 a wrongly shaped one does,
  // so config.yaml never accumulates decisions about plugins that do not exist.
  if (!(await loadPlugin(id))) return notFound(res);

  // Read the file rather than the in-memory config, the way PUT /api/config
  // does: an edit saved since the last reload is still the operator's, and a
  // merge against a stale snapshot would silently drop it.
  const existing = readConfigFile();
  if (!existing) {
    return serverError(res, `${CONFIG_PATH} could not be read as a config object; refusing to rewrite it`);
  }
  const plugins = (existing.plugins ?? {}) as Record<string, unknown>;
  saveConfigAtomic({ ...existing, plugins: { ...plugins, ...decidedLists(plugins, id, enabled) } });

  // Now rather than when the watcher notices: the operator is waiting on this
  // response, and the answer has to describe a gateway that already changed.
  context.reloadConfig?.();
  await reconcilePluginRuntime(context);
  context.emit("plugins:changed", {});
  logger.info(`Plugin "${id}" ${enabled ? "enabled" : "disabled"} by the operator`);
  json(res, { status: "ok", id, enabled });
}

/** The file manager to hand a directory to. `xdg-open` is the fallback rather
 *  than a third entry because every desktop Linux ships it and no other platform
 *  reaches here. */
function fileManagerBinary(): string {
  if (process.platform === "darwin") return "open";
  if (process.platform === "win32") return "explorer.exe";
  return "xdg-open";
}

/** Open a plugin's folder in the OS file manager. */
async function revealPluginFolder(res: ServerResponse, id: string): Promise<void> {
  // The directory is read off the plugin record, never off the request: an id is
  // the only thing a caller supplies, and discovery is what turns it into a path
  // inside the plugins directory.
  const plugin = await loadPlugin(id);
  if (!plugin) return notFound(res);

  // stdio ignored because nothing here reads it, and the default pipes deadlock
  // a child once an unread buffer fills; detached so the gateway is not holding
  // a file-manager window open for the rest of its life.
  const child = spawn(fileManagerBinary(), [plugin.dir], { stdio: "ignore", detached: true });
  // A missing binary arrives as an "error" event, and an unhandled one on a
  // ChildProcess is thrown at the process rather than at this request.
  child.on("error", (err) => logger.warn(`Could not open ${plugin.dir}: ${err.message}`));
  child.unref();
  json(res, { status: "ok", id });
}

/**
 * `POST /api/plugins/<id>/{enabled,reveal}`. See route-helpers.ts for the
 * domain-module contract; api.ts gates both operator-only before delegating.
 *
 * An id of the wrong shape is a 404, the same answer an id naming no installed
 * plugin gets, so neither response confirms what is on disk.
 */
export async function handlePluginAdminApi(
  req: HttpRequest,
  res: ServerResponse,
  route: ParsedRoute,
  context: ApiContext,
): Promise<boolean> {
  if (route.method !== "POST") return false;

  const enabledRoute = matchRoute(ENABLED_ROUTE, route.pathname);
  if (enabledRoute) {
    if (!PLUGIN_ID_PATTERN.test(enabledRoute.id)) notFound(res);
    else await setPluginEnabled(req, res, enabledRoute.id, context);
    return true;
  }

  const revealRoute = matchRoute(REVEAL_ROUTE, route.pathname);
  if (revealRoute) {
    if (!PLUGIN_ID_PATTERN.test(revealRoute.id)) notFound(res);
    else await revealPluginFolder(res, revealRoute.id);
    return true;
  }

  return false;
}
