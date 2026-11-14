import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { dispatchPluginRequest, disposePluginBackend, pluginSettings } from "../plugins/backend.js";
import { pluginClientModule } from "../plugins/client-transform.js";
import { inventoryRow, loadPlugin, scanPlugins, type DiscoveredPlugin } from "../plugins/discovery.js";
import { isPluginEnabled } from "../plugins/enablement.js";
import { readPluginEvents } from "../plugins/event-log.js";
import { isContainedIn, PLUGIN_ID_PATTERN, resolveContainedPath } from "../plugins/manifest.js";
import { pluginWatcherHealth } from "../plugins/watcher-supervisor.js";
import type { HundredfoldConfig } from "../shared/types.js";
import { handlePluginAdminApi, reconcilePluginRuntime } from "./plugins-admin-api.js";
import { badRequest, json, notFound, serverError, type ParsedRoute } from "./route-helpers.js";
import type { ApiContext } from "./api.js";

/**
 * The only suffixes served from a plugin's `assets/` directory, each with the type
 * it answers as. Membership is the allowlist, and everything else is a 404 rather
 * than a 403, so the response does not confirm the file exists. It is deliberately
 * not what keeps backend source off the wire: `.js` has to be on this list for a
 * client half to load, so `server.js` is unreachable because this route's root is
 * `<plugin>/assets/` and the plugin root sits above it. Add a type deliberately
 * when a new asset kind comes up; never change the fallback.
 */
const ASSET_TYPES: Record<string, string> = {
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

/** Exported so the auth-namespace test asserts against the prefix this router
 *  actually mounts under, rather than against a literal that could drift from it.
 *  Everything below `/api/` reaches the gateway's auth gate; a top-level route
 *  would not, and would be served to anyone who can reach the port. */
export const PLUGIN_ROUTE_PREFIX = "/api/plugins/";
const ASSETS_SEGMENT = "assets/";
const CLIENT_SEGMENT = "client";
const EVENTS_SEGMENT = "events";

/**
 * `/api/plugins/<id>/<tail>`, with the id held to exactly the shape discovery
 * requires, so a request can never name a directory discovery would refuse. An id
 * of the wrong shape falls through to api.ts's 404, the same answer a disabled or
 * unknown plugin gets.
 */
function matchPluginRoute(pathname: string): { id: string; tail: string } | null {
  if (!pathname.startsWith(PLUGIN_ROUTE_PREFIX)) return null;
  const separator = pathname.indexOf("/", PLUGIN_ROUTE_PREFIX.length);
  if (separator === -1) return null;
  const id = pathname.slice(PLUGIN_ROUTE_PREFIX.length, separator);
  if (!PLUGIN_ID_PATTERN.test(id)) return null;
  return { id, tail: pathname.slice(separator + 1) };
}

/**
 * The asset path a request names, decoded once. Traversal is deliberately not
 * judged here: containment decides it below, on the resolved path, so `..` gets
 * the same answer however it was spelled.
 */
function decodeAssetPath(raw: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!decoded || decoded.includes("\0")) return null;
  return decoded;
}

/** Plugin files hot-reload under a stable name, so no response here may be cached —
 *  the year-long immutable policy static assets get is exactly wrong for them. */
async function serveFile(res: ServerResponse, file: string, contentType: string): Promise<void> {
  let body: Buffer;
  try {
    body = await fs.readFile(file);
  } catch {
    // Absent, or a directory. Either way there is nothing at that path to serve.
    return notFound(res);
  }
  res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
  res.end(body);
}

/** The plugin a request may be answered from, or null when it must 404: unknown,
 *  never loaded, or not enabled. Read per request, so an operator disabling a
 *  plugin while the gateway runs takes effect on the next one. */
async function servablePlugin(id: string, context: ApiContext): Promise<DiscoveredPlugin | null> {
  if (!isPluginEnabled(id, context.getConfig())) return null;
  const plugin = await loadPlugin(id);
  return plugin?.status === "loaded" ? plugin : null;
}

/**
 * One row for the settings list, and whether the dashboard should load it.
 *
 * Watcher health is merged in here rather than in `inventoryRow`, which is built
 * from what is on disk: whether a background task is running is runtime state,
 * and discovery has no business knowing it. A client half that will not compile
 * is asked about for the same reason — settings renders this inventory and
 * nothing else, so a refusal only the browser ever saw would never reach the
 * row. Such a plugin stays servable all the same: the 422 the dashboard gets
 * back is what leaves whatever is already running in place, rather than
 * unloading it as a plugin that is gone.
 */
async function inventoryEntry(plugin: DiscoveredPlugin, config: HundredfoldConfig) {
  const row = inventoryRow(plugin);
  const servable = row.status === "loaded" && isPluginEnabled(row.id, config);
  // Absent, not a fabricated "stopped": most plugins have no watcher at all.
  const watcher = pluginWatcherHealth(row.id);
  const client = servable && plugin.client ? await pluginClientModule(row.id, plugin.client) : null;
  const refusal = client?.kind === "error" ? client.message : null;

  return {
    servable,
    row: {
      ...row,
      ...(row.status === "loaded" && !servable ? { status: "disabled" as const } : {}),
      ...(refusal ? { status: "error" as const, error: refusal } : {}),
      ...(watcher ? { watcher } : {}),
    },
  };
}

/** The inventory, plus the enabled subset the dashboard loads. A disabled plugin
 *  stays in the inventory: disabled is a state, not an absence. */
async function listPlugins(res: ServerResponse, context: ApiContext): Promise<void> {
  const config = context.getConfig();
  const entries = await Promise.all((await scanPlugins()).map((plugin) => inventoryEntry(plugin, config)));
  json(res, {
    plugins: entries.filter((entry) => entry.servable).map((entry) => entry.row),
    inventory: entries.map((entry) => entry.row),
  });
}

/**
 * The polling half of the events lane, and the complete one: a cursor is enough
 * to see every event the ring still holds, so the socket is only an accelerator.
 *
 * It reads the ring rather than the plugin, so a plugin whose backend is broken
 * still answers with what it emitted before it broke.
 */
async function servePluginEvents(res: ServerResponse, id: string, raw: string | null, context: ApiContext): Promise<void> {
  const since = raw === null ? undefined : Number(raw);
  if (since !== undefined && !(Number.isSafeInteger(since) && since >= 0)) {
    return badRequest(res, "since must be a non-negative integer");
  }
  // The same gate the rest of the plugin API uses, so a disabled and an unknown
  // id are one answer and neither confirms the plugin is installed.
  if (!(await servablePlugin(id, context))) return notFound(res);
  json(res, readPluginEvents(id, since));
}

/**
 * Exactly one file, named by the manifest rather than by the caller, compiled
 * only if it turns out to be JSX. A plain-ESM client half is still streamed from
 * disk, so what it is served as is what its author wrote, byte for byte.
 */
async function serveClient(res: ServerResponse, id: string, context: ApiContext): Promise<void> {
  const plugin = await servablePlugin(id, context);
  if (!plugin?.client) return notFound(res);

  const client = await pluginClientModule(id, plugin.client);
  // 422, because the file is installed and served and did not compile: 404
  // already means "not installed" and the dashboard unloads on it, and a 500
  // would blame the gateway for a plugin the operator can fix.
  if (client.kind === "error") return json(res, { error: client.message }, 422);
  if (client.kind === "transformed") {
    res.writeHead(200, { "Content-Type": "application/javascript", "Cache-Control": "no-store" });
    return void res.end(client.code);
  }
  // The client half is ESM by contract, whatever its file is called.
  await serveFile(res, plugin.client, "application/javascript");
}

async function serveAsset(res: ServerResponse, id: string, raw: string, context: ApiContext): Promise<void> {
  const asset = decodeAssetPath(raw);
  const contentType = asset ? ASSET_TYPES[path.extname(asset).toLowerCase()] : undefined;
  if (!asset || !contentType) return notFound(res);

  const plugin = await servablePlugin(id, context);
  if (!plugin) return notFound(res);

  const root = path.join(plugin.dir, "assets");
  const file = path.resolve(root, asset);
  if (!isContainedIn(root, file)) return notFound(res);

  const assetsRoot = await resolveContainedPath(plugin.dir, root);
  if (!assetsRoot) return notFound(res);
  const resolvedFile = await resolveContainedPath(assetsRoot, file);
  if (!resolvedFile) return notFound(res);
  await serveFile(res, resolvedFile, contentType);
}

/**
 * Everything else under `/api/plugins/<id>/` belongs to the plugin's own backend.
 * The enable gate is the same `servablePlugin` the client and asset routes use,
 * so a plugin the operator disabled a moment ago stops answering on the next
 * request rather than at the next restart. It sits here, inside the dispatch
 * chain, which the request handler reaches only after its auth gate has passed
 * (gateway/request-handler.ts) — a caller who cannot authenticate never learns
 * whether an id is installed.
 */
async function servePluginBackend(
  req: HttpRequest,
  res: ServerResponse,
  method: string,
  matched: { id: string; tail: string },
  context: ApiContext,
): Promise<void> {
  const plugin = await servablePlugin(matched.id, context);
  if (!plugin?.server) {
    disposePluginBackend(matched.id);
    return notFound(res);
  }

  const dispatched = await dispatchPluginRequest(req, res, {
    id: plugin.id,
    server: plugin.server,
    method,
    tail: matched.tail,
    readSettings: () => pluginSettings(plugin.id, context.getConfig()),
  });
  if (dispatched.outcome === "no-route") return notFound(res);
  if (dispatched.outcome === "failed") {
    // A plugin that wrote a response and then threw has already sent its status;
    // a second writeHead would throw out of the only error boundary api.ts has.
    if (res.headersSent) return void res.end();
    return serverError(res, dispatched.message);
  }
}

/**
 * The paths below `/api/plugins/<id>/` that belong to the gateway rather than to
 * the plugin, or false when this one does not. Matched ahead of the backend
 * mount, which is what stops a plugin registering a route of its own over one of
 * them: all three are how the dashboard reaches every plugin, and a plugin that
 * could take them could answer for the gateway.
 */
async function serveReservedPluginRoute(
  res: ServerResponse,
  matched: { id: string; tail: string },
  route: ParsedRoute,
  context: ApiContext,
): Promise<boolean> {
  if (route.method !== "GET") return false;
  if (matched.tail === CLIENT_SEGMENT) {
    await serveClient(res, matched.id, context);
    return true;
  }
  if (matched.tail.startsWith(ASSETS_SEGMENT)) {
    await serveAsset(res, matched.id, matched.tail.slice(ASSETS_SEGMENT.length), context);
    return true;
  }
  if (matched.tail === EVENTS_SEGMENT) {
    await servePluginEvents(res, matched.id, route.url.searchParams.get("since"), context);
    return true;
  }
  return false;
}

/** `/api/plugins*` routes. See route-helpers.ts for the domain-module contract. */
export async function handlePluginsApi(
  req: HttpRequest,
  res: ServerResponse,
  route: ParsedRoute,
  context: ApiContext,
): Promise<boolean> {
  const { method, pathname } = route;
  if (method === "GET" && pathname === "/api/plugins") {
    await listPlugins(res, context);
    return true;
  }
  // Operator-only; api.ts gates it before delegating.
  if (method === "POST" && pathname === "/api/plugins/rescan") {
    // Re-listing is not a rescan, and the button says rescan. What it has to do
    // is the pass the file watcher runs: drop the backends of plugins that
    // stopped being servable, and bring the running watchers back in line.
    await reconcilePluginRuntime(context);
    await listPlugins(res, context);
    return true;
  }
  // Ahead of the backend mount for the same reason the reserved routes below
  // are: the mount answers every method, so a plugin left free to register
  // `POST /enabled` could answer for the route that turns it off.
  if (await handlePluginAdminApi(req, res, route, context)) return true;

  // Every method, not just GET: the backend mount below answers all of them.
  const plugin = matchPluginRoute(pathname);
  if (!plugin) return false;
  if (await serveReservedPluginRoute(res, plugin, route, context)) return true;
  await servePluginBackend(req, res, method, plugin, context);
  return true;
}
