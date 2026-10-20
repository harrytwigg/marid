import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Muse Code engine's remote branch: an employee with a `remoteHost` runs its
 * turn's `muse serve` on that host over `ssh -T`.
 *
 * `ssh` here is fixtures/fake-ssh.mjs, which runs the remote command in a local
 * shell exactly as the remote host's would, so what is asserted is the command
 * the engine really builds: its `cd`, its sourced env file, its pid file and its
 * `exec env`, and then the fake `muse serve` (fixtures/fake-muse.mjs) speaking
 * MSP back through it. The remote kill's control connection runs the real kill
 * script the same way. Only the two steps that would read and stage a real
 * host (readiness and staging) are replaced.
 */

vi.mock("../../shared/logger.js", () => ({ logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("../../sessions/employee-env.js", () => ({ employeeSessionEnv: () => ({}) }));

const hoisted = vi.hoisted(() => ({
  ready: true as boolean,
  readyCalls: [] as Array<Record<string, unknown>>,
  prepareCalls: [] as Array<Record<string, unknown>>,
  /** The stage the fake `prepareRemoteSession` reports. */
  stage: { sessionHome: "", envFilePath: "", resolvedMcp: undefined as unknown },
  facts: {} as Record<string, unknown>,
}));

vi.mock("../remote-stage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../remote-stage.js")>();
  return {
    ...actual,
    ensureRemoteReady: vi.fn(async (_target: unknown, _remote: unknown, opts: Record<string, unknown>) => {
      hoisted.readyCalls.push(opts);
      return hoisted.ready ? { ready: true, facts: hoisted.facts } : { ready: false, reason: "build-box is asleep" };
    }),
    prepareRemoteSession: vi.fn(async (opts: Record<string, unknown>) => {
      hoisted.prepareCalls.push(opts);
      return {
        engine: "musecode",
        destination: "builder@build-box",
        tunnelPort: 41234,
        sessionHome: hoisted.stage.sessionHome,
        envFilePath: hoisted.stage.envFilePath,
        ...(hoisted.stage.resolvedMcp ? { resolvedMcp: hoisted.stage.resolvedMcp } : {}),
      };
    }),
  };
});

import { MusecodeEngine } from "../musecode.js";
import type { EngineRunOpts, ResolvedMcpConfig } from "../../shared/types.js";
import { FAKE, ctx, requests, sent, starts, useFakeMuse } from "./helpers/fake-muse-harness.js";

const FAKE_SSH = path.join(path.dirname(FAKE), "fake-ssh.mjs");

useFakeMuse();

let root: string;
let remoteCwd: string;
let sshLog: string;
let engine: MusecodeEngine;
let gatewayPort = 7777;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "musecode-remote-"));
  remoteCwd = path.join(root, "work");
  const sessionHome = path.join(root, "stage", "sessions", "s1__musecode");
  fs.mkdirSync(remoteCwd, { recursive: true });
  fs.mkdirSync(path.join(sessionHome, "tmp"), { recursive: true });
  const envFilePath = path.join(sessionHome, "tmp", "session-env.sh");
  fs.writeFileSync(envFilePath, "export JINN_GATEWAY_URL='http://127.0.0.1:41234'\n", { mode: 0o600 });
  hoisted.stage = { sessionHome, envFilePath, resolvedMcp: undefined };
  hoisted.facts = { home: root, stageDir: path.join(root, "stage"), nodeBin: process.execPath, museBin: FAKE, jinnVersion: "0.0.0", entryDir: "/remote/mcp" };
  hoisted.ready = true;
  hoisted.readyCalls.length = 0;
  hoisted.prepareCalls.length = 0;
  // `ssh` on PATH is the fake; everything else (sh, node, ps) is the real one.
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.symlinkSync(FAKE_SSH, path.join(bin, "ssh"));
  vi.stubEnv("PATH", `${bin}:${path.dirname(process.execPath)}:${process.env.PATH ?? ""}`);
  sshLog = path.join(root, "ssh.jsonl");
  vi.stubEnv("FAKE_SSH_LOG", sshLog);
  gatewayPort = 7777;
  engine = new MusecodeEngine({ remote: () => ({ root, mount: "/mnt/jinn-home" }), gatewayPort: () => gatewayPort });
});

afterEach(() => {
  engine.killAll();
  fs.rmSync(root, { recursive: true, force: true });
});

function remoteOpts(over: Partial<EngineRunOpts> = {}): EngineRunOpts {
  // `cwd` is the gateway's; the turn must not run there.
  return { prompt: "hello", cwd: ctx.tmp, sessionId: "s1", remoteHost: "build-box", remoteUser: "builder", remoteCwd, ...over } as EngineRunOpts;
}

/** Every ssh the engine opened, as argv. */
const sshCalls = (): string[][] => (fs.existsSync(sshLog) ? fs.readFileSync(sshLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const isControl = (argv: string[]) => /^sh -s /.test(argv[argv.length - 1] ?? "");
const turnSsh = () => sshCalls().filter((argv) => !isControl(argv));

describe("a remote employee's turn", () => {
  it("runs `muse serve` on its host over ssh -T, in its remote working directory, and answers", async () => {
    const result = await engine.run(remoteOpts({ model: "muse-spark-1.3" }));
    expect(result.error).toBeUndefined();
    expect(result.result).toBe("fake muse: hello");

    const [argv] = turnSsh();
    expect(argv).toBeDefined();
    expect(argv![0]).toBe("-T");
    expect(argv).toEqual(expect.arrayContaining(["-o", "BatchMode=yes", "-R", "41234:127.0.0.1:7777", "--", "builder@build-box"]));
    const command = argv![argv!.length - 1]!;
    expect(command.startsWith(`cd '${remoteCwd}' && . '${hoisted.stage.envFilePath}' && printf `)).toBe(true);
    expect(command).toContain(`> '${path.join(hoisted.stage.sessionHome, "tmp", "engine.pid")}' && exec env '-u' 'CLAUDECODE'`);
    expect(command).toContain(`'${FAKE}' 'serve' '--disable-sandbox' '--trust-workspace'`);
    expect(command).toContain("'--model' 'muse-spark-1.3'");

    // The host ran there: in the remote cwd, with the staged home and the env file's gateway URL.
    const start = starts()[0]!;
    expect(start.cwd).toBe(fs.realpathSync(remoteCwd));
    expect(start.env.JINN_HOME).toBe(hoisted.stage.sessionHome);
    expect(start.env.JINN_GATEWAY_URL).toBe("http://127.0.0.1:41234");
    expect(sent("session/start")[0]).toMatchObject({ workspaceRoot: remoteCwd, approvalMode: "allowAll" });

    expect(hoisted.readyCalls).toEqual([{ engine: "musecode", allowWake: false }]);
    expect(hoisted.prepareCalls[0]).toMatchObject({ engine: "musecode", jinnSessionId: "s1", gatewayPort: 7777 });
  });

  it("reaps a previous turn's host on that machine before starting this one", async () => {
    await engine.run(remoteOpts());
    const calls = sshCalls();
    const reap = calls.findIndex(isControl);
    const turn = calls.findIndex((argv) => !isControl(argv));
    expect(reap).toBeGreaterThanOrEqual(0);
    expect(reap).toBeLessThan(turn);
  });

  it("hands Muse the MCP set re-pointed at the host, over stdin and never on a command line", async () => {
    const capability = "cap-for-this-session-only";
    const local: ResolvedMcpConfig = { mcpServers: { jinn: { command: "/gateway/node", args: ["/gateway/server-entry.js"], env: { JINN_SESSION_CAPABILITY: capability } } } };
    hoisted.stage.resolvedMcp = { mcpServers: { jinn: { command: "/remote/node", args: ["/remote/mcp/server-entry.js"], env: { JINN_SESSION_CAPABILITY: capability } } } };
    await engine.run(remoteOpts({ resolvedMcp: local }));

    expect(hoisted.prepareCalls[0]!.resolvedMcp).toBe(local);
    expect(sent("session/start")[0]!.config.mcpServers.jinn).toMatchObject({ transport: "stdio", command: "/remote/node", args: ["/remote/mcp/server-entry.js"], mode: "optional" });
    expect(sshCalls().flat().join(" ")).not.toContain(capability);
  });

  it("sends image attachments inline from the gateway and names the rest as the host sees them", async () => {
    const png = path.join(ctx.tmp, "shot.png");
    fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const home = process.env.JINN_HOME!;
    const notes = path.join(home, "knowledge", "notes.txt");
    fs.mkdirSync(path.dirname(notes), { recursive: true });
    fs.writeFileSync(notes, "notes");
    await engine.run(remoteOpts({ prompt: "look", attachments: [png, notes] }));
    const input = sent("turn/start")[0]!.input;
    expect(input[0]).toEqual({ type: "text", text: `look\n\nAttached files:\n- ${path.join(hoisted.stage.sessionHome, "knowledge", "notes.txt")}` });
    expect(input[1]).toMatchObject({ type: "image", mediaType: "image/png" });
  });

  it("ends a host that ignores the interrupt on its own machine, then lets the client go", async () => {
    const run = engine.run(remoteOpts({ prompt: "work\n\n---\n\nSTUCK" }));
    const pidFile = path.join(hoisted.stage.sessionHome, "tmp", "engine.pid");
    await vi.waitFor(() => expect(requests().some((r) => r.method === "turn/start")).toBe(true), { timeout: 10_000 });
    const pid = Number(fs.readFileSync(pidFile, "utf8").split("\n")[0]);
    expect(isAlive(pid)).toBe(true);

    engine.kill("s1", "Interrupted by the operator");
    const result = await run;
    expect(result.error).toBe("Interrupted by the operator");
    // The kill ran over a control connection with the turn's pid file, after the turn's own ssh.
    const calls = sshCalls();
    const kills = calls.map((argv, i) => [argv, i] as const).filter(([argv]) => isControl(argv) && argv.at(-1)!.includes(`'${pidFile}'`));
    expect(kills.length).toBeGreaterThanOrEqual(2); // the pre-spawn reap and the interrupt
    expect(kills.at(-1)![1]).toBeGreaterThan(calls.findIndex((argv) => !isControl(argv)));
    await vi.waitFor(() => expect(isAlive(pid)).toBe(false), { timeout: 10_000 });
  }, 30_000);
});

describe("a remote turn that cannot start", () => {
  it("is refused on a host that is not ready, with its reason, and opens no turn", async () => {
    hoisted.ready = false;
    await expect(engine.run(remoteOpts())).rejects.toThrow("remote host not ready: build-box is asleep");
    expect(turnSsh()).toEqual([]);
    expect(starts()).toEqual([]);
  });

  it("is refused without the gateway's port, which the reverse tunnel needs", async () => {
    gatewayPort = 0;
    await expect(engine.run(remoteOpts())).rejects.toThrow("remote spawn needs the gateway's port");
    expect(sshCalls()).toEqual([]);
  });

  it("is refused when the host has no `muse`, naming the host and the binary", async () => {
    hoisted.facts = { ...hoisted.facts, museBin: undefined };
    await expect(engine.run(remoteOpts())).rejects.toThrow("builder@build-box has no `muse` on the non-interactive PATH");
    expect(turnSsh()).toEqual([]);
  });

  it("runs locally, as before, for an employee with no remote host", async () => {
    const result = await engine.run({ ...remoteOpts(), remoteHost: undefined, bin: FAKE } as EngineRunOpts);
    expect(result.result).toBe("fake muse: hello");
    expect(sshCalls()).toEqual([]);
    expect(starts()[0]!.cwd).toBe(fs.realpathSync(ctx.tmp));
  });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
