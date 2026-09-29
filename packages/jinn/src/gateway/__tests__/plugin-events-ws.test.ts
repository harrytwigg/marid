import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import yaml from "js-yaml";
import WebSocket from "ws";

/** paths.js reads JINN_HOME once, so every gateway import below is dynamic and
 *  happens after this. Same reason as plugins-api-harness.ts. */
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-plugin-events-ws-"));
process.env.JINN_HOME = tmpHome;

const TOKEN = "test-token";
const PLUGIN_ID = "streamer";

fs.mkdirSync(path.join(tmpHome, "plugins", PLUGIN_ID), { recursive: true });
fs.writeFileSync(
  path.join(tmpHome, "plugins", PLUGIN_ID, "plugin.json"),
  JSON.stringify({ id: PLUGIN_ID, name: "Streamer", version: "1.0.0" }),
);
fs.writeFileSync(path.join(tmpHome, "plugins", PLUGIN_ID, "client.js"), "export default {}");
fs.writeFileSync(
  path.join(tmpHome, "config.yaml"),
  yaml.dump({
    // authRequired, so an unauthenticated upgrade is refused rather than waved
    // through on a loopback host — which is what makes the anonymous case below
    // test anything.
    gateway: { authRequired: true },
    engines: { default: "codex", claude: {}, codex: { bin: "codex", model: "gpt-5.5" } },
    portal: { portalName: "Portal COO", setupComplete: true },
    connectors: {},
    mcp: {},
    sessions: {},
    plugins: { enabled: [PLUGIN_ID] },
  }),
);

let server: http.Server;
let port: number;
let cookie: string;
let emit: (id: string, event: unknown) => void;
let channel: import("../plugin-events-ws.js").PluginEventsChannel;

beforeAll(async () => {
  const { loadConfig } = await import("../../shared/config.js");
  const config = loadConfig();
  const { authenticateGatewayRequest, authRequiredForRequest, shouldRequireGatewayAuth, createAuthSession, authCookieName, authDeviceCookieName } = await import("../auth.js");
  const { createPluginEventsChannel, matchPluginEventsPath } = await import("../plugin-events-ws.js");
  const { rejectCrossOriginUpgrade } = await import("../upgrade-guards.js");
  const browser = createAuthSession(tmpHome, { headers: { "user-agent": "plugin-events-ws test" }, socket: { remoteAddress: "127.0.0.1" } } as never, { kind: "local", name: "plugin-events-ws test" });
  cookie = `${authCookieName(tmpHome)}=${browser.secret}; ${authDeviceCookieName(tmpHome)}=${browser.device.id}`;
  ({ appendPluginEvent: emit } = await import("../../plugins/event-log.js"));

  channel = createPluginEventsChannel(() => config);
  server = http.createServer();

  // The gateway's upgrade gate, in the order server.ts runs it: authenticate
  // first, match the path second, then refuse a browser on a foreign origin.
  // Every check is the real one from auth.ts and upgrade-guards.ts, but their
  // order here is a copy: server.ts's handler is a closure inside startGateway.
  // The source tests in pty-upgrade-origin.test.ts pin that the gateway itself
  // wires them this way.
  server.on("upgrade", (req, socket, head) => {
    const pathname = (req.url || "").split("?")[0];
    if (shouldRequireGatewayAuth(config) && authRequiredForRequest("GET", pathname)) {
      if (!authenticateGatewayRequest(req, TOKEN, tmpHome).ok) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
    }
    const id = matchPluginEventsPath(pathname);
    if (id) {
      if (rejectCrossOriginUpgrade(req, socket)) return;
      return channel.handleUpgrade(req, socket, head, id);
    }
    socket.destroy();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  for (const client of channel.wss.clients) client.terminate();
  await new Promise<void>((resolve) => channel.wss.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function connect(target: string, headers: Record<string, string> = {}): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}${target}`, { headers });
}

function authed(target: string): WebSocket {
  return connect(target, { authorization: `Bearer ${TOKEN}` });
}

/** How the upgrade ended: open, or the reason it did not. */
function settle(ws: WebSocket): Promise<{ opened: boolean; status?: number }> {
  return new Promise((resolve) => {
    ws.on("open", () => resolve({ opened: true }));
    ws.on("unexpected-response", (_req, res) => resolve({ opened: false, status: res.statusCode }));
    ws.on("error", () => resolve({ opened: false }));
  });
}

/** The next frame, parsed. */
function nextPage(ws: WebSocket): Promise<{ events: { cursor: number; event: unknown }[]; cursor: number; dropped: boolean }> {
  return new Promise((resolve) => ws.once("message", (raw) => resolve(JSON.parse(raw.toString()))));
}

describe("the upgrade gate", () => {
  it("rejects an unauthenticated upgrade exactly as the rest of /api/ is rejected", async () => {
    const anonymous = await settle(connect(`/api/plugins/${PLUGIN_ID}/events`));
    expect(anonymous).toEqual({ opened: false, status: 401 });

    const withToken = await settle(authed(`/api/plugins/${PLUGIN_ID}/events`));
    expect(withToken.opened).toBe(true);
  });

  // the cookie flows from a same-site sibling subdomain, so a browser
  // there could read every plugin's event stream on the operator's session.
  it("refuses the operator's cookie from a sibling subdomain with a 403", async () => {
    const sibling = await settle(connect(`/api/plugins/${PLUGIN_ID}/events`, {
      cookie, host: "jinn.example.test", origin: "https://blog.example.test",
    }));
    expect(sibling).toEqual({ opened: false, status: 403 });

    const behindProxy = await settle(connect(`/api/plugins/${PLUGIN_ID}/events`, {
      cookie, "x-forwarded-host": "jinn.example.test", origin: "https://blog.example.test",
    }));
    expect(behindProxy).toEqual({ opened: false, status: 403 });
  });

  it("admits the cookie from the gateway's own origin, direct, proxied or through Vite dev", async () => {
    const ownOrigins: Record<string, string>[] = [
      { origin: `http://127.0.0.1:${port}` },
      { host: "jinn.example.test", origin: "https://jinn.example.test" },
      { "x-forwarded-host": "jinn.example.test", origin: "https://jinn.example.test" },
      { "x-forwarded-host": "localhost:5173", origin: "http://localhost:5173" },
    ];
    for (const headers of ownOrigins) {
      const ws = connect(`/api/plugins/${PLUGIN_ID}/events`, { cookie, ...headers });
      expect(await settle(ws), JSON.stringify(headers)).toEqual({ opened: true });
      ws.close();
    }
  });

  it("leaves a caller with no Origin to the auth gate: the native shell's cookie socket, an API client", async () => {
    const native = connect(`/api/plugins/${PLUGIN_ID}/events`, { cookie });
    expect(await settle(native)).toEqual({ opened: true });
    native.close();
  });

  it("has no authentication of its own to keep in step with that gate", () => {
    // A negative no integration test can show: that the socket path never grows
    // a second, divergent token check. Asserted against the source, with the
    // comments stripped so that explaining the delegation does not read as
    // performing it.
    const code = fs
      .readFileSync(fileURLToPath(new URL("../plugin-events-ws.ts", import.meta.url)), "utf-8")
      .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

    expect(code).not.toMatch(/from "\.\/auth\.js"/);
    expect(code).not.toMatch(/verifyGatewayAuth|authenticateGatewayRequest|authRequiredForRequest/);
    expect(code).not.toMatch(/token|bearer/i);
  });

  it("refuses a disabled and an unknown plugin the same way", async () => {
    const disabled = await settle(authed("/api/plugins/shelved/events"));
    const unknown = await settle(authed("/api/plugins/nosuchplugin/events"));

    expect(disabled.opened).toBe(false);
    expect(disabled).toEqual(unknown);
  });
});

describe("the events socket", () => {
  it("replays from the cursor on connect, then pushes live appends", async () => {
    emit(PLUGIN_ID, { step: "first" });
    emit(PLUGIN_ID, { step: "second" });

    const ws = authed(`/api/plugins/${PLUGIN_ID}/events`);
    const replay = await nextPage(ws);
    expect(replay.events.map((record) => record.event)).toEqual([{ step: "first" }, { step: "second" }]);

    const live = nextPage(ws);
    emit(PLUGIN_ID, { step: "third" });
    expect(await live).toEqual({
      events: [{ cursor: replay.cursor + 1, event: { step: "third" } }],
      cursor: replay.cursor + 1,
      dropped: false,
    });
    ws.close();
  });

  it("replays only what came after the cursor the client asked from", async () => {
    emit(PLUGIN_ID, { step: "before" });
    const from = (await nextPage(authed(`/api/plugins/${PLUGIN_ID}/events`))).cursor;
    emit(PLUGIN_ID, { step: "after" });

    const ws = authed(`/api/plugins/${PLUGIN_ID}/events?since=${from}`);
    const replay = await nextPage(ws);

    expect(replay.events).toEqual([{ cursor: from + 1, event: { step: "after" } }]);
    ws.close();
  });

  it("keeps one plugin's socket blind to another's events", async () => {
    const ws = authed(`/api/plugins/${PLUGIN_ID}/events`);
    await nextPage(ws);

    const seen: unknown[] = [];
    ws.on("message", (raw) => seen.push(JSON.parse(raw.toString())));
    emit("someone-else", { step: "theirs" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(seen).toEqual([]);
    ws.close();
  });
});
