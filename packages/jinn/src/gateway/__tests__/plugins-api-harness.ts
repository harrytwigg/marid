import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import yaml from "js-yaml";

/**
 * The rig plugins-api.test.ts drives the routes through: a private instance home,
 * a plugin installer, and a request that enters handleApiRequest the way the
 * server calls it. It lives beside the test rather than in it because the routes
 * pushed the suite past the size ratchet.
 *
 * JINN_HOME is set here, at module scope, because paths.js reads it once — every
 * gateway import has to come after this file's body has run, which is why the
 * test reaches api.js through `startHarness` instead of importing it.
 */
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-plugins-api-"));
process.env.JINN_HOME = tmpHome;
export const pluginsDir = path.join(tmpHome, "plugins");
export const configPath = path.join(tmpHome, "config.yaml");

fs.mkdirSync(path.join(tmpHome, "sessions"), { recursive: true });
fs.mkdirSync(path.join(tmpHome, "org"), { recursive: true });

type Api = typeof import("../api.js");
let api: Api;
let auth: typeof import("../auth.js");
let requestHandler: ReturnType<(typeof import("../request-handler.js"))["createGatewayRequestHandler"]>;
let loadConfigFromDisk: (() => import("../../shared/types.js").JinnConfig) | null = null;
let currentConfig: import("../../shared/types.js").JinnConfig;

function reloadConfig(): void {
  if (!loadConfigFromDisk) throw new Error("plugin API harness has not started");
  currentConfig = loadConfigFromDisk();
  apiCtx.config = currentConfig;
}

/** The operator's lists, as `config.yaml` carries them. */
export function writeConfig(
  plugins?: { enabled?: string[]; disabled?: string[]; settings?: Record<string, Record<string, unknown>> },
  gateway: Record<string, unknown> = {},
): void {
  fs.writeFileSync(
    configPath,
    yaml.dump({
      gateway,
      engines: { default: "codex", claude: {}, codex: { bin: "codex", model: "gpt-5.5" } },
      portal: { portalName: "Portal COO", setupComplete: true },
      connectors: {},
      mcp: {},
      sessions: {},
      ...(plugins ? { plugins } : {}),
    }),
  );
}

const apiCtx = {
  getConfig: () => currentConfig,
  reloadConfig,
  reloadOrg: () => {},
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: () => {},
  sessionManager: {
    getEngines: () => new Map([["codex", {}]]),
    getEngine: () => undefined,
    getQueue: () => ({ getPendingCount: () => 0, getRowlessWaitingCount: () => 0, getTransportState: (_key: string, status: string) => status }),
  },
} as unknown as import("../api.js").ApiContext;

function makeRes() {
  let status = 200;
  const headers: Record<string, string> = {};
  const chunks: Buffer[] = [];
  let headersSent = false;
  const res = {
    get headersSent() {
      return headersSent;
    },
    writeHead(code: number, sent?: Record<string, string>) {
      // Node throws ERR_HTTP_HEADERS_SENT on a second call. Mirrored, because a
      // plugin writing and then throwing is exactly the case that would hit it.
      if (headersSent) throw new Error("Cannot set headers after they are sent to the client");
      headersSent = true;
      status = code;
      Object.assign(headers, sent ?? {});
      return this;
    },
    setHeader(name: string, value: string) {
      headers[name] = value;
      return this;
    },
    end(buf?: Buffer | string) {
      if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    },
  } as unknown as ServerResponse;
  return {
    res,
    headers,
    get status() {
      return status;
    },
    get bodyText() {
      return Buffer.concat(chunks).toString("utf-8");
    },
    get body() {
      return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    },
  };
}

function makeReq(method: string, urlPath: string, headers: Record<string, string>, body?: unknown) {
  const raw = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  return Object.assign(Readable.from(raw), {
    method,
    url: urlPath,
    headers: { host: "localhost", ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    socket: { remoteAddress: "127.0.0.1" },
  }) as unknown as Parameters<Api["handleApiRequest"]>[0];
}

/** A request straight into the dispatch chain, the way the server calls it.
 *  `body` is serialised as JSON, for the routes that read one. */
export async function call(
  method: string,
  urlPath: string,
  headers: Record<string, string> = { authorization: "Bearer test-token" },
  body?: unknown,
) {
  const cap = makeRes();
  await api.handleApiRequest(makeReq(method, urlPath, headers, body), cap.res, apiCtx);
  return cap;
}

/**
 * A request through the gateway's own request handler, so the order it runs its
 * auth gate and its API dispatch in is executed rather than described. Nothing
 * here re-implements that order: hoisting the dispatch above the gate in
 * request-handler.ts is what the auth-parity case has to notice.
 */
export async function callThroughAuthGate(method: string, urlPath: string, headers: Record<string, string> = {}) {
  const cap = makeRes();
  await requestHandler(makeReq(method, urlPath, headers), cap.res);
  return cap;
}

/** A plugin directory. `client.js` is written unless the case replaces it. */
export function install(id: string, manifest: unknown, files: Record<string, string> = {}): void {
  const dir = path.join(pluginsDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify(manifest));
  for (const [name, content] of Object.entries({ "client.js": "export default { id: 'x' }", ...files })) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
}

/** Boot the gateway modules against the private home, and hand back the hooks
 *  the auth-namespace and config-reload assertions need. */
export async function startHarness(): Promise<{
  authRequiredForRequest: (typeof import("../auth.js"))["authRequiredForRequest"];
  onConfigReload: () => void;
  routePrefix: string;
  /** Boot's watcher pass, awaitable. `onConfigReload` starts one of its own and
   *  does not wait on it, so a case that has to observe the result awaits this. */
  reconcileWatchers: () => Promise<void>;
}> {
  writeConfig();
  ({ loadConfig: loadConfigFromDisk } = await import("../../shared/config.js"));
  reloadConfig();
  api = await import("../api.js");
  (await import("../../shared/db.js")).initDb();
  auth = await import("../auth.js");
  const { createGatewayRequestHandler } = await import("../request-handler.js");
  requestHandler = createGatewayRequestHandler({
    authRequired: () => auth.shouldRequireGatewayAuth(currentConfig),
    gatewayAuthToken: "test-token",
    home: tmpHome,
    apiContext: apiCtx,
    // Nothing is built into this home, so serveStatic falls through and the
    // static branch answers the same 404 a real gateway's would.
    webDir: path.join(tmpHome, "web"),
  });
  const { gatewayWatchCallbacks } = await import("../watch-callbacks.js");
  const { PLUGIN_ROUTE_PREFIX } = await import("../plugins-api.js");
  const { onConfigReload } = gatewayWatchCallbacks({
    reloadConfig,
    getConfig: () => currentConfig,
    reloadOrg: () => {},
    emit: () => {},
  });
  const { reconcilePluginWatchers } = await import("../../plugins/watcher-supervisor.js");
  return {
    authRequiredForRequest: auth.authRequiredForRequest,
    onConfigReload,
    routePrefix: PLUGIN_ROUTE_PREFIX,
    reconcileWatchers: () => reconcilePluginWatchers(() => currentConfig),
  };
}

/**
 * Re-read `config.yaml` and nothing else.
 *
 * `onConfigReload` also disposes backends and reconciles watchers, so a case
 * that uses it can never observe a rescan doing that work. This models the state
 * a rescan exists for: config on disk has moved on, and the runtime built from
 * the old one is still running.
 */
export function reloadConfigOnly(): void {
  reloadConfig();
}

/** An empty plugins directory, the state every case starts from. */
export function resetPlugins(): void {
  fs.rmSync(pluginsDir, { recursive: true, force: true });
  fs.mkdirSync(pluginsDir, { recursive: true });
}
