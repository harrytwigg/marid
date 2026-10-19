import { beforeEach, describe, expect, it, vi } from "vitest";
import { envName } from "../../shared/codename-env.js";

interface FakePty {
  pid: number;
  killed: boolean;
  writes: string[];
  onData: (cb: (d: string) => void) => void;
  onExit: (cb: (e: { exitCode: number }) => void) => void;
  on: (event: string, cb: (...a: any[]) => void) => void;
  kill: (sig?: string) => void;
  resize: (cols: number, rows: number) => void;
  write: (data: string) => void;
  _exit: (code?: number) => void;
}
interface SpawnCall { bin: string; args: string[]; opts: any; proc: FakePty }
const spawnCalls: SpawnCall[] = [];

function makeFakePty(): FakePty {
  let exitCb: ((e: { exitCode: number }) => void) | undefined;
  const p: FakePty = {
    pid: 4000 + spawnCalls.length,
    killed: false,
    writes: [],
    onData: () => {},
    onExit: (cb) => { exitCb = cb; },
    on: () => {},
    kill: () => { p.killed = true; queueMicrotask(() => exitCb?.({ exitCode: 0 })); },
    resize: () => {},
    write: (d) => { p.writes.push(d); },
    _exit: (code = 0) => { exitCb?.({ exitCode: code }); },
  };
  return p;
}

vi.mock("node-pty", () => ({
  spawn: vi.fn((bin: string, args: string[], opts: any) => {
    const proc = makeFakePty();
    spawnCalls.push({ bin, args, opts, proc });
    return proc as unknown as import("node-pty").IPty;
  }),
}));
vi.mock("../../shared/logger.js", () => ({ logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("../../sessions/employee-env.js", () => ({ employeeSessionEnv: (id?: string) => (id === "s1" ? { JINN_EMPLOYEE: "worker" } : {}) }));

import { spawn as ptySpawn } from "node-pty";
import type { ResolvedMcpConfig } from "../../shared/types.js";
import { isDeadSessionError } from "../../shared/rateLimit.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";
import { MUSECODE_TURN_RUNNING, MUSECODE_VIEW_ONLY, MusecodeInteractiveEngine, type MusecodeInteractiveDeps } from "../musecode-interactive.js";

const ID = "01a13fb8-5801-7983-8ae6-77432f86606b";
const OTHER = "01a13fb9-0000-7000-8000-000000000002";

function make(deps: MusecodeInteractiveDeps = {}) {
  const lifecycle = new PtyLifecycleManager({ maxLivePtys: 8 });
  return { lifecycle, engine: new MusecodeInteractiveEngine(lifecycle, deps) };
}

beforeEach(() => {
  spawnCalls.length = 0;
  vi.stubEnv("CLAUDECODE", "1");
  vi.stubEnv("CODEX_HOME", "/somewhere");
  vi.stubEnv("META_API_KEY", "key-from-gateway");
});

describe("MusecodeInteractiveEngine", () => {
  it("never runs a work turn: the view is view-only", async () => {
    const { engine } = make();
    const result = await engine.run({ prompt: "hi", cwd: "/tmp", sessionId: "s1" });
    expect(result).toEqual({ sessionId: "", result: "", error: MUSECODE_VIEW_ONLY });
  });

  it("says so as a failure on an intact conversation, never as a dead session", async () => {
    const { engine } = make();
    const result = await engine.run({ prompt: "hi", cwd: "/tmp", sessionId: "s1", resumeSessionId: ID });
    expect(result).toMatchObject({ sessionId: ID, error: MUSECODE_VIEW_ONLY, numTurns: 1, conversationIntact: true });
    expect(isDeadSessionError(result)).toBe(false);
  });

  it("spawns `muse resume <id>` in the session's cwd, with the turn's scrubbed environment", () => {
    const { engine } = make({ bin: () => "/opt/muse" });
    engine.ensureIdleSpawn("s1", { engineSessionId: ID, cwd: "/work/a", model: "muse-spark-1.2", cols: 100, rows: 30 });
    expect(spawnCalls).toHaveLength(1);
    const call = spawnCalls[0];
    expect(call.bin).toBe("/opt/muse");
    expect(call.args.slice(0, 4)).toEqual(["resume", ID, "--disable-sandbox", "--trust-workspace"]);
    expect(call.args).toContain("muse-spark-1.2");
    expect(call.opts).toMatchObject({ cwd: "/work/a", cols: 100, rows: 30 });
    expect(call.opts.env).toMatchObject({ JINN_SESSION_ID: "s1", JINN_EMPLOYEE: "worker", META_API_KEY: "key-from-gateway", TERM: "xterm-256color" });
    expect(call.opts.env.CLAUDECODE).toBeUndefined();
    expect(call.opts.env.CODEX_HOME).toBeUndefined();
  });

  it("opens a fresh TUI when the session has no conversation yet", () => {
    const { engine } = make({ bin: () => "/opt/muse" });
    engine.ensureIdleSpawn("s1", { cwd: "/work/a" });
    expect(spawnCalls[0].args[0]).toBe("--disable-sandbox");
    expect(spawnCalls[0].args).not.toContain("resume");
  });

  it("carries the session's MCP set and the employee's flags, with the values in the environment only", () => {
    const resolvedMcp = { mcpServers: { jinn: { command: "/usr/bin/node", args: ["/x/entry.js"], env: { JINN_SESSION_ID: "s1" } } } } as unknown as ResolvedMcpConfig;
    const { engine } = make({ bin: () => "/opt/muse", resolveLaunch: () => ({ cliFlags: ["--provider", "echo"], resolvedMcp }) });
    engine.ensureIdleSpawn("s1", { engineSessionId: ID, cwd: "/work/a" });
    const { args, opts } = spawnCalls[0];
    expect(args.slice(-2)).toEqual(["--provider", "echo"]);
    expect(args.some((a) => a.startsWith("mcpServers.jinn="))).toBe(true);
    expect(args.join(" ")).not.toContain("s1\"");
    expect(opts.env[envName("MCP_") + "1"]).toBe("s1");
  });

  it("reuses a warm view, and reopens one that was opened before the conversation existed", () => {
    const { engine } = make({ bin: () => "/opt/muse" });
    engine.ensureIdleSpawn("s1", { cwd: "/w" });
    engine.ensureIdleSpawn("s1", { cwd: "/w" });
    expect(spawnCalls).toHaveLength(1);
    engine.ensureIdleSpawn("s1", { cwd: "/w", engineSessionId: ID });
    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[0].proc.killed).toBe(true);
    expect(spawnCalls[1].args.slice(0, 2)).toEqual(["resume", ID]);
    engine.ensureIdleSpawn("s1", { cwd: "/w", engineSessionId: ID });
    expect(spawnCalls).toHaveLength(2);
    engine.ensureIdleSpawn("s1", { cwd: "/w", engineSessionId: OTHER });
    expect(spawnCalls).toHaveLength(3);
  });

  it("forwards input and resizes to the process, and kills it on kill", () => {
    const { engine } = make({ bin: () => "/opt/muse" });
    engine.ensureIdleSpawn("s1", { cwd: "/w" });
    engine.writeStdin("s1", "hello");
    engine.writeRaw("s1", "\u001b[A");
    expect(spawnCalls[0].proc.writes).toEqual(["hello\r", "\u001b[A"]);
    expect(engine.isAlive("s1")).toBe(true);
    engine.kill("s1");
    expect(engine.isAlive("s1")).toBe(false);
    expect(spawnCalls[0].proc.killed).toBe(true);
  });

  describe("while a turn is running", () => {
    it("opens no terminal, however the socket asks, and opens one once the turn is over", () => {
      let running = true;
      const { engine } = make({ bin: () => "/opt/muse", turnRunning: () => running });
      expect(() => engine.ensureIdleSpawn("s1", { engineSessionId: ID, cwd: "/w" })).toThrow(MUSECODE_TURN_RUNNING);
      expect(() => engine.restartPty("s1", { engineSessionId: ID, cwd: "/w" })).toThrow(MUSECODE_TURN_RUNNING);
      expect(spawnCalls).toHaveLength(0);
      running = false;
      engine.ensureIdleSpawn("s1", { engineSessionId: ID, cwd: "/w" });
      expect(spawnCalls).toHaveLength(1);
    });

    it("does not reopen a terminal the turn closed, when a hidden tab comes back", async () => {
      let running = false;
      const { engine } = make({ bin: () => "/opt/muse", turnRunning: () => running });
      engine.ensureIdleSpawn("s1", { engineSessionId: ID, cwd: "/w" });
      engine.setViewing("s1", true);
      engine.setViewing("s1", false);
      running = true;
      await engine.releaseUnviewed("s1");
      engine.setViewing("s1", true);
      expect(() => engine.ensureIdleSpawn("s1", { engineSessionId: ID, cwd: "/w" })).toThrow(MUSECODE_TURN_RUNNING);
      expect(spawnCalls).toHaveLength(1);
    });

    it("leaves a warm terminal on the right conversation alone", () => {
      let running = false;
      const { engine } = make({ bin: () => "/opt/muse", turnRunning: () => running });
      engine.ensureIdleSpawn("s1", { engineSessionId: ID, cwd: "/w" });
      running = true;
      expect(() => engine.ensureIdleSpawn("s1", { engineSessionId: ID, cwd: "/w" })).not.toThrow();
    });
  });

  describe("releaseUnviewed", () => {
    it("closes a terminal nobody is looking at, and waits for the process to go", async () => {
      const { engine } = make({ bin: () => "/opt/muse" });
      engine.ensureIdleSpawn("s1", { engineSessionId: ID, cwd: "/w" });
      engine.setViewing("s1", true);
      engine.setViewing("s1", false);
      await engine.releaseUnviewed("s1");
      expect(spawnCalls[0].proc.killed).toBe(true);
      expect(engine.hasWarmPty("s1")).toBe(false);
    });

    it("leaves a terminal someone has open", async () => {
      const { engine } = make({ bin: () => "/opt/muse" });
      engine.ensureIdleSpawn("s1", { engineSessionId: ID, cwd: "/w" });
      engine.setViewing("s1", true);
      await engine.releaseUnviewed("s1");
      expect(spawnCalls[0].proc.killed).toBe(false);
      expect(engine.hasWarmPty("s1")).toBe(true);
    });

    it("counts a viewer once across a restart, since the socket enters again after it", async () => {
      const { engine } = make({ bin: () => "/opt/muse" });
      engine.ensureIdleSpawn("s1", { engineSessionId: ID, cwd: "/w" });
      engine.setViewing("s1", true);
      engine.restartPty("s1", { engineSessionId: ID, cwd: "/w" });
      engine.setViewing("s1", true);
      await engine.releaseUnviewed("s1");
      expect(spawnCalls[1].proc.killed).toBe(false);
      engine.setViewing("s1", false);
      await engine.releaseUnviewed("s1");
      expect(spawnCalls[1].proc.killed).toBe(true);
    });

    it("keeps no viewer count for a terminal a failed restart killed", async () => {
      const { engine } = make({ bin: () => "/opt/muse" });
      engine.ensureIdleSpawn("s1", { engineSessionId: ID, cwd: "/w" });
      engine.setViewing("s1", true);
      vi.mocked(ptySpawn).mockImplementationOnce(() => { throw new Error("spawn ENOENT"); });
      expect(() => engine.restartPty("s1", { engineSessionId: ID, cwd: "/w" })).toThrow("spawn ENOENT");
      expect(spawnCalls[0].proc.killed).toBe(true);
      expect(engine.hasWarmPty("s1")).toBe(false);

      // A fresh terminal counts from zero: one enter and one leave leave it unviewed.
      engine.ensureIdleSpawn("s1", { engineSessionId: ID, cwd: "/w" });
      expect(spawnCalls).toHaveLength(2);
      engine.setViewing("s1", true);
      engine.setViewing("s1", false);
      await engine.releaseUnviewed("s1");
      expect(spawnCalls[1].proc.killed).toBe(true);
      expect(engine.hasWarmPty("s1")).toBe(false);
    });

    it("does nothing when there is no terminal", async () => {
      const { engine } = make();
      await expect(engine.releaseUnviewed("s1")).resolves.toBeUndefined();
    });
  });

  it("releases its lifecycle entry when the process exits by itself", () => {
    const { engine } = make({ bin: () => "/opt/muse" });
    engine.ensureIdleSpawn("s1", { cwd: "/w" });
    spawnCalls[0]!.proc._exit(0);
    expect(engine.hasWarmPty("s1")).toBe(false);
  });
});
