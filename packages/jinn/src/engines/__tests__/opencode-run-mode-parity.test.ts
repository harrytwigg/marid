import fs from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PassThrough, Writable } from "node:stream";

/**
 * `engines.opencode.mode: run` must be the engine exactly as it was before
 * server mode existed.
 *
 * This engine is every claude employee's rate-limit fallback, so the default
 * path is held to "provably unchanged", not "probably fine": for local and
 * remote turns, fresh and resumed, with and without jinn tools, the process the
 * engine spawns — binary, argv, environment, cwd and what it writes on stdin —
 * is compared between an engine built the way the gateway built it before
 * (`new OpencodeEngine({ remote, gatewayPort })`) and one built the way it is
 * built now, with a server pool attached and the mode read as `run` or absent.
 * The pool is a tripwire: `run` mode must never touch it.
 *
 * The literal argv below pins the command itself. For the cross-branch proof,
 * set OPENCODE_PARITY_DUMP=<file> and run this file on the base commit and on
 * the branch: the two dumps must be byte-identical (the PR records that diff).
 */

const REMOTE_HOME = "/home/builder/.jinn-remote-stage/sessions/sess-1__opencode";
const REMOTE_BIN = "/home/builder/.local/bin/opencode";

const hoisted = vi.hoisted(() => ({
  spawns: [] as { bin: string; args: string[]; env: Record<string, string>; cwd: unknown; stdin: string }[],
  withConfig: true,
}));

vi.mock("node:child_process", () => ({
  spawn: vi.fn((bin: string, args: string[], opts: { env?: Record<string, string>; cwd?: unknown }) => {
    const record = { bin, args, env: { ...(opts.env ?? {}) }, cwd: opts.cwd, stdin: "" };
    hoisted.spawns.push(record);
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new Writable({ write(chunk, _enc, cb) { record.stdin += String(chunk); cb(); } });
    const proc = {
      pid: 4242,
      exitCode: null as number | null,
      killed: false,
      stdout,
      stderr,
      stdin,
      kill: () => true,
      unref: () => {},
      on(event: string, cb: (arg: number) => void) {
        if (event !== "close") return proc;
        setTimeout(() => {
          stdout.write(`${JSON.stringify({ type: "text", sessionID: "ses_parity", part: { type: "text", text: "ok" } })}\n`);
          stdout.end();
          proc.exitCode = 0;
          cb(0);
        }, 0);
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
    ensureRemoteReady: vi.fn(async () => ({
      ready: true,
      facts: {
        home: "/home/builder",
        stageDir: "/home/builder/.jinn-remote-stage",
        nodeBin: "/home/builder/.nvm/versions/node/v22.22.3/bin/node",
        opencodeBin: REMOTE_BIN,
        jinnVersion: "0.33.3",
        entryDir: "/home/builder/.nvm/versions/node/v22.22.3/lib/node_modules/jinn-cli/dist/src/mcp",
      },
    })),
    prepareRemoteSession: vi.fn(async () => ({
      engine: "opencode",
      destination: "builder@build-box",
      tunnelPort: 44321,
      sessionHome: REMOTE_HOME,
      envFilePath: `${REMOTE_HOME}/tmp/session-env.sh`,
      ...(hoisted.withConfig ? { opencodeConfigPath: `${REMOTE_HOME}/tmp/opencode.json` } : {}),
    })),
  };
});

vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { OpencodeEngine } from "../opencode.js";
import { JINN_HOME } from "../../shared/paths.js";
import type { EngineRunOpts, ResolvedMcpConfig } from "../../shared/types.js";

const REMOTE_CONFIG = { root: "/srv/jinn-work", mount: "/mnt/jinn-home" };
const GATEWAY_PORT = 8722;
const MCP: ResolvedMcpConfig = {
  mcpServers: {
    jinn: { command: "node", args: ["/opt/jinn/mcp.js"], env: { JINN_SESSION_ID: "sess-1", JINN_SESSION_CAPABILITY: "cap-xyz" } },
  },
} as ResolvedMcpConfig;

/** A pool that fails the test if `run` mode so much as looks at it. */
function tripwirePool(): { touched: string[]; pool: never } {
  const touched: string[] = [];
  const handler: ProxyHandler<object> = {
    get(_t, prop) {
      // size() is the one question run mode may ask ("any servers to stop?").
      if (prop === "size") return () => 0;
      if (prop === "then") return undefined;
      return () => { touched.push(String(prop)); throw new Error(`run mode touched the server pool: ${String(prop)}`); };
    },
  };
  return { touched, pool: new Proxy({}, handler) as never };
}

type Build = { name: string; make: () => { engine: OpencodeEngine; touched?: string[] } };

const BUILDS: Build[] = [
  // How server.ts built the engine before server mode existed.
  { name: "legacy constructor", make: () => ({ engine: new OpencodeEngine({ remote: () => REMOTE_CONFIG, gatewayPort: () => GATEWAY_PORT }) }) },
  {
    name: "pool attached, mode run",
    make: () => {
      const t = tripwirePool();
      return {
        engine: new OpencodeEngine({ remote: () => REMOTE_CONFIG, gatewayPort: () => GATEWAY_PORT, mode: () => "run", servers: t.pool }),
        touched: t.touched,
      };
    },
  },
  {
    name: "pool attached, mode absent",
    make: () => {
      const t = tripwirePool();
      return { engine: new OpencodeEngine({ remote: () => REMOTE_CONFIG, gatewayPort: () => GATEWAY_PORT, servers: t.pool }), touched: t.touched };
    },
  },
];

const CASES: Array<{ name: string; opts: Partial<EngineRunOpts>; withConfig?: boolean }> = [
  { name: "local fresh, jinn tools", opts: { resolvedMcp: MCP, systemPrompt: "You are Ada." } },
  { name: "local resumed, no tools", opts: { resumeSessionId: "ses_prev" } },
  { name: "local with cli flags", opts: { cliFlags: ["--agent", "build"], resolvedMcp: MCP } },
  { name: "remote fresh, jinn tools", opts: { remoteHost: "build-box", remoteUser: "builder", remoteCwd: "/srv/jinn-work/proj", resolvedMcp: MCP } },
  { name: "remote resumed, no config", opts: { remoteHost: "build-box", remoteUser: "builder", remoteCwd: "/srv/jinn-work/proj", resumeSessionId: "ses_prev" }, withConfig: false },
];

function baseOpts(over: Partial<EngineRunOpts>): EngineRunOpts {
  return { prompt: "build it", cwd: JINN_HOME, sessionId: "sess-1", model: "opencode-go/deepseek-v4.1-flash", ...over };
}

/** The spawn as a comparable value. Staged config paths are per session, not
 *  per run, so they compare as-is; test-runner noise in the env is dropped. */
function normalize(spawn: (typeof hoisted.spawns)[number]) {
  const env = Object.fromEntries(Object.entries(spawn.env).filter(([k]) => !k.startsWith("VITEST") && k !== "TEST"));
  return { bin: spawn.bin, args: spawn.args, env, cwd: spawn.cwd, stdin: spawn.stdin };
}

async function capture(build: Build, c: (typeof CASES)[number]) {
  hoisted.spawns = [];
  hoisted.withConfig = c.withConfig ?? true;
  const { engine, touched } = build.make();
  const result = await engine.run(baseOpts(c.opts));
  expect(result.error).toBeUndefined();
  if (touched) expect(touched).toEqual([]);
  expect(hoisted.spawns).toHaveLength(1);
  return normalize(hoisted.spawns[0]!);
}

beforeEach(() => {
  hoisted.spawns = [];
});

describe("opencode `run` mode is the engine as it was", () => {
  for (const c of CASES) {
    it(`${c.name}: every construction spawns the identical process`, async () => {
      const results = [];
      for (const build of BUILDS) results.push(await capture(build, c));
      for (const r of results.slice(1)) expect(r).toEqual(results[0]);
    });
  }

  it("local argv is exactly `run --format json --dangerously-skip-permissions [-m] [-s]`, prompt on stdin", async () => {
    const local = await capture(BUILDS[1]!, CASES[1]!);
    expect(local.args).toEqual([
      "run", "--format", "json", "--dangerously-skip-permissions",
      "-m", "opencode-go/deepseek-v4.1-flash",
      "-s", "ses_prev",
    ]);
    expect(local.stdin).toBe("build it");
    expect(local.args.join(" ")).not.toContain("--attach");
    expect(local.env.OPENCODE_SERVER_PASSWORD).toBeUndefined();
    expect(local.env.OPENCODE_DISABLE_AUTOUPDATE).toBe("1");
    expect(local.env.JINN_SESSION_ID).toBe("sess-1");
  });

  it("remote argv keeps the reverse tunnel, no -L and a plain opencode run", async () => {
    const remote = await capture(BUILDS[1]!, CASES[3]!);
    expect(remote.args).toContain("-R");
    expect(remote.args).not.toContain("-L");
    expect(remote.args).toContain("-T");
    expect(remote.args.at(-1)).toContain("'run' '--format' 'json' '--dangerously-skip-permissions'");
    expect(remote.args.at(-1)).not.toContain("--attach");
  });

  it("OPENCODE_PARITY_DUMP writes every case for a cross-branch diff", async () => {
    const out = process.env.OPENCODE_PARITY_DUMP;
    if (!out) return;
    // What the ENGINE decided, independent of the runner: the env as a delta
    // against the parent environment, and the per-run temp home as a token.
    const home = (v: unknown) => (typeof v === "string" ? v.split(JINN_HOME).join("<JINN_HOME>") : v);
    const dump: Record<string, unknown> = {};
    for (const build of BUILDS) {
      for (const c of CASES) {
        const spawn = await capture(build, c);
        const set = Object.fromEntries(
          Object.entries(spawn.env).filter(([k, v]) => process.env[k] !== v).map(([k, v]) => [k, home(v)]),
        );
        const removed = Object.keys(process.env).filter((k) => !(k in spawn.env) && !k.startsWith("VITEST")).sort();
        dump[`${build.name} / ${c.name}`] = {
          bin: home(spawn.bin), args: spawn.args.map(home), cwd: home(spawn.cwd), stdin: spawn.stdin, envSet: set, envRemoved: removed,
        };
      }
    }
    fs.writeFileSync(out, `${JSON.stringify(dump, null, 2)}\n`);
  });
});
