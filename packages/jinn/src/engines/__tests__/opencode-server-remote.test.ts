import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PassThrough, Writable } from "node:stream";

/**
 * opencode server mode for a remote employee.
 *
 * One process crosses the ssh hop — the SERVER: a long-lived ssh with a tty (a
 * dropped link hangs it up), the reverse tunnel its MCP servers reach the
 * gateway through, and a `-L` forward the gateway reaches its API through.
 * Everything else rides that forward: each TURN is HTTP from the gateway (no
 * per-turn ssh at all), and an INTERRUPT is an abort sent the same way. And
 * the server password never appears on any command line.
 *
 * The argv builder is the real one; only what would touch a real host is
 * faked — ssh, the host facts, and the server's HTTP answers.
 */

const REMOTE_HOME = "/home/builder/.jinn-remote-stage/sessions/sess-1__opencode";
const REMOTE_BIN = "/home/builder/.local/bin/opencode";
const SERVER_PORT = 47001;

const hoisted = vi.hoisted(() => ({
  spawns: [] as { bin: string; args: string[]; kind: string }[],
  prepareCalls: [] as Record<string, unknown>[],
  fetches: [] as { url: string; method: string; auth: string | undefined; at: number }[],
  controls: [] as { script: string; args: string[]; at: number }[],
  /** opencode sessions the fake server reports busy. */
  busy: new Set<string>(),
  hangTurn: false,
  tick: 0,
  servers: [] as Array<{ close: (code: number) => void }>,
  sse: [] as ReadableStreamDefaultController<Uint8Array>[],
}));

vi.mock("node:child_process", () => ({
  spawn: vi.fn((bin: string, args: string[]) => {
    const last = args.at(-1) ?? "";
    const kind = /^sh -s /.test(last) ? "control" : last.includes("'serve'") ? "server" : "other";
    hoisted.spawns.push({ bin, args, kind });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let controlStdin = "";
    const stdin = new Writable({ write(chunk, _e, cb) { if (kind === "control") controlStdin += String(chunk); cb(); } });
    const listeners: Record<string, Array<(arg: unknown) => void>> = {};
    const proc = {
      pid: kind === "server" ? 7001 : 7003,
      exitCode: null as number | null,
      signalCode: null as string | null,
      killed: false,
      stdout, stderr, stdin,
      kill: () => true,
      unref: () => {},
      close(code: number) {
        if (proc.exitCode !== null) return;
        stdout.end();
        proc.exitCode = code;
        for (const cb of listeners.exit ?? []) cb(code);
        for (const cb of listeners.close ?? []) cb(code);
      },
      on(event: string, cb: (arg: unknown) => void) {
        (listeners[event] ??= []).push(cb);
        if (event !== "close") return proc;
        if (kind === "control") {
          setTimeout(() => {
            hoisted.controls.push({ script: controlStdin, args, at: ++hoisted.tick });
            stdout.write("terminated\n");
            proc.close(0);
          }, 5);
        } else if (kind === "server") {
          hoisted.servers.push(proc);
        }
        return proc;
      },
    };
    return proc;
  }),
}));

vi.mock("../remote-stage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../remote-stage.js")>();
  return {
    ...actual,
    reapStaleRemoteEngine: vi.fn(async () => {}),
    probeFreePort: vi.fn(async () => SERVER_PORT),
    ensureRemoteReady: vi.fn(async () => ({
      ready: true,
      facts: {
        home: "/home/builder",
        stageDir: "/home/builder/.jinn-remote-stage",
        nodeBin: "/home/builder/.nvm/versions/node/v22.22.3/bin/node",
        opencodeBin: REMOTE_BIN,
        jinnVersion: "0.33.3",
        entryDir: "/x",
      },
    })),
    prepareRemoteSession: vi.fn(async (opts: Record<string, unknown>) => {
      hoisted.prepareCalls.push(opts);
      return {
        engine: "opencode",
        destination: "builder@build-box",
        tunnelPort: 44321,
        sessionHome: REMOTE_HOME,
        envFilePath: `${REMOTE_HOME}/tmp/session-env.sh`,
        opencodeConfigPath: `${REMOTE_HOME}/tmp/opencode.json`,
      };
    }),
  };
});

vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { OpencodeEngine } from "../opencode.js";
import { OpencodeServerPool } from "../opencode-server.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";
import { JINN_HOME } from "../../shared/paths.js";
import type { EngineRunOpts } from "../../shared/types.js";

const REMOTE_CONFIG = { root: "/srv/jinn-work", mount: "/mnt/jinn-home" };
const GATEWAY_PORT = 8722;

function setup() {
  const lifecycle = new PtyLifecycleManager({ maxLivePtys: 8, enforceLocalCap: false });
  const pool = new OpencodeServerPool(lifecycle, { remote: () => REMOTE_CONFIG, gatewayPort: () => GATEWAY_PORT });
  const engine = new OpencodeEngine({ remote: () => REMOTE_CONFIG, gatewayPort: () => GATEWAY_PORT, mode: () => "server", servers: pool });
  return { pool, engine };
}

function runOpts(over: Partial<EngineRunOpts> = {}): EngineRunOpts {
  return {
    prompt: "build it",
    cwd: JINN_HOME,
    sessionId: "sess-1",
    model: "opencode-go/deepseek-v4.1-flash",
    remoteHost: "build-box",
    remoteUser: "builder",
    remoteCwd: "/srv/jinn-work/proj",
    ...over,
  };
}

function password(): string {
  const env = (hoisted.prepareCalls[0]?.sessionEnv ?? {}) as Record<string, string>;
  return env.OPENCODE_SERVER_PASSWORD ?? "";
}

let killSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  hoisted.spawns = [];
  hoisted.prepareCalls = [];
  hoisted.fetches = [];
  hoisted.controls = [];
  hoisted.busy = new Set();
  hoisted.hangTurn = false;
  hoisted.tick = 0;
  hoisted.servers = [];
  hoisted.sse = [];
  // The engine signals local process GROUPS; never let a fake pid reach the OS.
  killSpy = vi.spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    hoisted.fetches.push({ url, method: init.method ?? "GET", auth: headers.authorization, at: ++hoisted.tick });
    const route = new URL(url).pathname;
    const json = (body: unknown, status = 200) => new Response(body === undefined ? null : JSON.stringify(body), { status });
    if (route === "/event") {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          hoisted.sse.push(controller);
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`));
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (route === "/global/health") return json({ healthy: true, version: "1.18.31" });
    if (route === "/session" && init.method === "POST") return json({ id: "ses_remote1" });
    if (route === "/session/status") return json(Object.fromEntries([...hoisted.busy].map((id) => [id, { type: "busy" }])));
    const abort = route.match(/^\/session\/([^/]+)\/abort$/);
    if (abort) {
      const id = decodeURIComponent(abort[1]!);
      hoisted.busy.delete(id);
      publish("session.status", { sessionID: id, status: { type: "idle" } });
      publish("session.idle", { sessionID: id });
      return json(true);
    }
    const prompt = route.match(/^\/session\/([^/]+)\/prompt_async$/);
    if (prompt) {
      const id = decodeURIComponent(prompt[1]!);
      const parentID = (JSON.parse(String(init.body)) as { messageID: string }).messageID;
      const reply = `msg_reply${++hoisted.tick}`;
      hoisted.busy.add(id);
      setTimeout(() => {
        publish("session.status", { sessionID: id, status: { type: "busy" } });
        publish("message.updated", { sessionID: id, info: { id: reply, sessionID: id, role: "assistant", parentID } });
        publish("message.part.updated", { sessionID: id, part: { sessionID: id, messageID: reply, type: "step-start" } });
        if (hoisted.hangTurn) return;
        publish("message.part.updated", { sessionID: id, part: { sessionID: id, messageID: reply, type: "text", text: "done over there", time: { start: 1, end: 2 } } });
        hoisted.busy.delete(id);
        publish("session.status", { sessionID: id, status: { type: "idle" } });
        publish("session.idle", { sessionID: id });
      }, 5);
      return json(undefined, 204);
    }
    return json(true);
  }));
});

function publish(type: string, properties: Record<string, unknown>): void {
  const chunk = new TextEncoder().encode(`data: ${JSON.stringify({ type, properties })}\n\n`);
  for (const c of hoisted.sse) {
    try { c.enqueue(chunk); } catch { /* closed by the turn */ }
  }
}

afterEach(() => {
  killSpy.mockRestore();
  vi.unstubAllGlobals();
});

describe("opencode server mode on a remote host", () => {
  it("carries the server on one tty ssh with the tunnel and an API forward; turns ride the forward", async () => {
    const { engine, pool } = setup();
    const result = await engine.run(runOpts());
    expect(result.error).toBeUndefined();
    expect(result.result).toBe("done over there");
    expect(result.sessionId).toBe("ses_remote1");

    // Exactly one ssh: the server. No per-turn client over there.
    const ssh = hoisted.spawns.filter((s) => s.kind !== "control");
    expect(ssh.map((s) => s.kind)).toEqual(["server"]);
    const server = ssh[0]!;
    expect(server.bin).toMatch(/ssh$/);

    // Server: tty, reverse tunnel, API forward, pid recorded for a deliberate stop.
    expect(server.args[0]).toBe("-tt");
    expect(server.args).toContain(`44321:127.0.0.1:${GATEWAY_PORT}`);
    const fwd = server.args[server.args.indexOf("-L") + 1]!;
    expect(fwd).toMatch(new RegExp(`^127\\.0\\.0\\.1:\\d+:127\\.0\\.0\\.1:${SERVER_PORT}$`));
    const serverCmd = server.args.at(-1)!;
    expect(serverCmd).toContain(`'${REMOTE_BIN}' 'serve' '--port' '${SERVER_PORT}' '--hostname' '127.0.0.1'`);
    expect(serverCmd).toContain(`OPENCODE_CONFIG='${REMOTE_HOME}/tmp/opencode.json'`);
    expect(serverCmd).toContain(`${REMOTE_HOME}/tmp/opencode-server.pid`);
    expect(serverCmd).toContain(`. '${REMOTE_HOME}/tmp/session-env.sh'`);

    // Everything the gateway says to the server goes through the forward, with the password.
    const localPort = fwd.split(":")[1];
    const auth = `Basic ${Buffer.from(`opencode:${password()}`).toString("base64")}`;
    const routes = hoisted.fetches.map((f) => `${f.method} ${new URL(f.url).pathname}`);
    // The first /event is the pool waiting out the instance bootstrap; the second is the turn's.
    expect(routes).toEqual(["GET /global/health", "GET /event", "GET /event", "POST /session", "POST /session/ses_remote1/prompt_async"]);
    for (const f of hoisted.fetches) {
      expect(f.url.startsWith(`http://127.0.0.1:${localPort}/`)).toBe(true);
      expect(f.auth).toBe(auth);
    }
    expect(pool.get("sess-1")?.hostKey).toBe("build-box");
  });

  it("stages the password into the 0600 env file and never onto a command line", async () => {
    const { engine } = setup();
    await engine.run(runOpts());
    const pw = password();
    expect(pw.length).toBeGreaterThanOrEqual(24);
    for (const spawn of hoisted.spawns) {
      expect(spawn.args.join(" ")).not.toContain(pw);
    }
  });

  it("a second turn reuses the server: no second serve, no restaging", async () => {
    const { engine } = setup();
    await engine.run(runOpts());
    await engine.run(runOpts({ resumeSessionId: "ses_remote1" }));
    expect(hoisted.spawns.filter((s) => s.kind === "server")).toHaveLength(1);
    expect(hoisted.prepareCalls).toHaveLength(1);
    expect(hoisted.fetches.filter((f) => f.url.endsWith("/prompt_async"))).toHaveLength(2);
    expect(hoisted.fetches.filter((f) => f.method === "POST" && new URL(f.url).pathname === "/session")).toHaveLength(1);
  });

  it("an interrupt aborts on the server through the forward and settles once the server is idle", async () => {
    const { engine, pool } = setup();
    hoisted.hangTurn = true;
    const turn = engine.run(runOpts({ prompt: "keep going" }));
    await vi.waitFor(() => expect(hoisted.busy.has("ses_remote1")).toBe(true));
    engine.kill("sess-1", "Interrupted: operator");
    const result = await turn;
    expect(result.error).toBe("Interrupted: operator");

    const localPort = pool.get("sess-1")!.apiUrl.split(":").pop();
    const abort = hoisted.fetches.find((f) => f.url === `http://127.0.0.1:${localPort}/session/ses_remote1/abort`);
    expect(abort?.method).toBe("POST");
    // Nothing was killed over ssh: the server survives, only the turn stopped.
    expect(hoisted.controls).toHaveLength(0);
    expect(pool.get("sess-1")).toBeDefined();
  });
});
