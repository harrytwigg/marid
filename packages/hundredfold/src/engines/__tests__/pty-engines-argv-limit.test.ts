import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * The codex and grok engines, like claude, put prompt text on a command line:
 * codex's interactive PTY the whole message (a fresh session's system prompt
 * folded in front of it), grok's interactive PTY the system prompt, and both
 * headless engines the message. Over Linux's per-argument limit the exec is
 * refused; under node-pty the forked child prints the refusal and exits 1, and
 * the turn used to settle as a quiet interruption with the reason lost.
 *
 * Each turn over the limit must fail up front, naming the size and the limit,
 * and spawn nothing; and a process that dies before its session starts must be
 * reported as a failed start carrying its output, not as an interruption.
 */

interface FakePty {
  pid: number;
  _exitCode: number | null;
  written: string[];
  onData: (cb: (d: string) => void) => { dispose: () => void };
  onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => { dispose: () => void };
  on: () => void;
  kill: () => void;
  resize: () => void;
  write: (data: string) => void;
  _emit: (data: string) => void;
  _exit: (code?: number) => void;
}

const ptySpawns: Array<{ bin: string; args: string[]; proc: FakePty }> = [];

function makeFakePty(): FakePty {
  const dataCbs: Array<(d: string) => void> = [];
  const exitCbs: Array<(e: { exitCode: number; signal?: number }) => void> = [];
  const p: FakePty = {
    pid: 7000 + ptySpawns.length,
    _exitCode: null,
    written: [],
    onData: (cb) => { dataCbs.push(cb); return { dispose: () => {} }; },
    onExit: (cb) => { exitCbs.push(cb); return { dispose: () => {} }; },
    on: () => {},
    kill: () => {},
    resize: () => {},
    write: (data) => { p.written.push(data); },
    _emit: (data) => { for (const cb of [...dataCbs]) cb(data); },
    _exit: (code = 0) => { p._exitCode = code; for (const cb of [...exitCbs]) cb({ exitCode: code, signal: 0 }); },
  };
  return p;
}

vi.mock("node-pty", () => ({
  spawn: vi.fn((bin: string, args: string[]) => {
    const proc = makeFakePty();
    ptySpawns.push({ bin, args, proc });
    return proc;
  }),
}));

const childSpawns = vi.hoisted(() => [] as Array<{ bin: string; args: string[] }>);
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const spawn = vi.fn((bin: string, args: string[]) => {
    childSpawns.push({ bin, args });
    throw new Error("the test does not run headless CLIs");
  });
  return { ...actual, spawn, default: { ...((actual as any).default ?? actual), spawn } };
});

// Codex and grok look for their transcripts under the home directory.
const osMockState = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fsm = await import("node:fs");
  const pathm = await import("node:path");
  osMockState.home = fsm.mkdtempSync(pathm.join(actual.tmpdir(), "pty-argv-limit-home-"));
  const homedir = () => osMockState.home;
  return { ...actual, homedir, default: { ...((actual as any).default ?? actual), homedir } };
});

import { CodexInteractiveEngine, describeCodexArgument } from "../codex-interactive.js";
import { GrokInteractiveEngine, buildGrokInteractiveArgs, describeGrokArgument } from "../grok-interactive.js";
import { CodexEngine } from "../codex.js";
import { GrokEngine } from "../grok.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";
import { processStartFailure } from "../../shared/process-start.js";

const flush = () => new Promise((r) => setTimeout(r, 20));
const LIMIT = /over the operating system's limit of 131,071 bytes for one command-line argument/;
const realPlatform = process.platform;

let lifecycle: PtyLifecycleManager;

beforeEach(() => {
  ptySpawns.length = 0;
  childSpawns.length = 0;
  // The cap is Linux's; hold the tests to it on any host.
  Object.defineProperty(process, "platform", { value: "linux" });
  lifecycle = new PtyLifecycleManager({ maxLivePtys: 10 });
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform });
  lifecycle.killAll();
});

describe("describeCodexArgument / describeGrokArgument", () => {
  it("names the message, the system prompt, and anything else by position", () => {
    const codexArgs = ["--model", "m", "--", "hello"];
    expect(describeCodexArgument(codexArgs, 3, "the message")).toBe("the message");
    expect(describeCodexArgument(codexArgs, 1, "the message")).toBe("command-line argument 2");

    const grokArgs = buildGrokInteractiveArgs({ model: "m" } as any, undefined, "persona");
    expect(describeGrokArgument(grokArgs, grokArgs.indexOf("persona"))).toBe("the system prompt");
    expect(describeGrokArgument(grokArgs, 0)).toBe("command-line argument 1");
  });
});

describe("CodexInteractiveEngine — a prompt too long for one argument", () => {
  let engine: CodexInteractiveEngine;
  beforeEach(() => { engine = new CodexInteractiveEngine(lifecycle); });

  it("fails the turn up front, naming the size and the limit, and leaves nothing running", async () => {
    await expect(engine.run({ sessionId: "cx-big", prompt: "p".repeat(136_066), cwd: "/tmp" } as any))
      .rejects.toThrow(/^Codex cannot be started with this turn: the message is 136,066 bytes, /);
    await expect(engine.run({ sessionId: "cx-big", prompt: "p".repeat(136_066), cwd: "/tmp" } as any)).rejects.toThrow(LIMIT);
    expect(ptySpawns).toHaveLength(0);
    expect(engine.isTurnRunning("cx-big")).toBe(false);
  });

  it("counts a fresh session's system prompt, which codex takes in front of the message", async () => {
    await expect(engine.run({ sessionId: "cx-sys", prompt: "m".repeat(80_000), systemPrompt: "s".repeat(80_000), cwd: "/tmp" } as any))
      .rejects.toThrow(/the message \(with its system prompt\) is 160,0\d\d bytes/);
    expect(ptySpawns).toHaveLength(0);
  });

  it("names only what is folded into the message: nothing on a resume, the attachment list when there is one", async () => {
    await expect(engine.run({
      sessionId: "cx-resume", prompt: "p".repeat(136_066), systemPrompt: "persona", resumeSessionId: "thread-1", cwd: "/tmp",
    } as any)).rejects.toThrow(/^Codex cannot be started with this turn: the message is 136,066 bytes, /);
    await expect(engine.run({
      sessionId: "cx-attach", prompt: "p".repeat(136_066), attachments: ["/tmp/a.txt"], cwd: "/tmp",
    } as any)).rejects.toThrow(/^Codex cannot be started with this turn: the message \(with its attachment list\) is 136,0\d\d bytes, /);
    expect(ptySpawns).toHaveLength(0);
  });

  it("spawns a prompt that fits", async () => {
    void engine.run({ sessionId: "cx-fits", prompt: "p".repeat(120_000), cwd: "/tmp" } as any);
    await flush();
    expect(ptySpawns).toHaveLength(1);
    expect(ptySpawns[0].args[ptySpawns[0].args.length - 1]).toHaveLength(120_000);
  });

  it("pastes an oversized prompt into a warm PTY, which takes no command line", async () => {
    engine.ensureIdleSpawn("cx-warm", { cwd: "/tmp", model: "gpt-5.5" });
    expect(ptySpawns).toHaveLength(1);
    void engine.run({ sessionId: "cx-warm", prompt: "p".repeat(136_066), cwd: "/tmp", model: "gpt-5.5" } as any);
    await flush();
    expect(ptySpawns).toHaveLength(1);
    expect(ptySpawns[0].proc.written.join("")).toContain("p".repeat(136_066));
  });

  it("does not bind a local spawn on macOS, which has no per-argument cap", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    void engine.run({ sessionId: "cx-mac", prompt: "p".repeat(136_066), cwd: "/tmp" } as any);
    await flush();
    expect(ptySpawns).toHaveLength(1);
  });

  it("reports a process that dies before its session starts as a failed start, with its output", async () => {
    const run = engine.run({ sessionId: "cx-dies", prompt: "hello", cwd: "/tmp" } as any);
    await flush();
    const proc = ptySpawns[0].proc;
    proc._emit("execvp(3) failed.: Argument list too long\r\n");
    proc._exit(1);
    const result = await run;
    expect(result.error).toBe(processStartFailure("codex", { exitCode: 1, signal: 0 }, "execvp(3) failed.: Argument list too long"));
    expect(result.error).not.toMatch(/^Interrupted/);
  });

  it("still reports a started process's death as an interruption", async () => {
    const run = engine.run({ sessionId: "cx-started", prompt: "hello", cwd: "/tmp" } as any);
    await flush();
    // The process recorded its session, so it started.
    const sessionsDir = path.join(osMockState.home, ".codex", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, "rollout-started.jsonl"), JSON.stringify({ type: "session_meta", payload: { id: "thread-started", cwd: "/tmp" } }) + "\n");
    ptySpawns[0].proc._exit(1);
    expect((await run).error).toBe("Interrupted: codex process exited (code 1, signal 0)");
  });
});

describe("GrokInteractiveEngine — a system prompt too long for one argument", () => {
  let engine: GrokInteractiveEngine;
  beforeEach(() => { engine = new GrokInteractiveEngine(lifecycle); });

  it("fails the turn up front, naming the system prompt, its size and the limit, and leaves nothing running", async () => {
    await expect(engine.run({ sessionId: "gk-big", prompt: "hi", systemPrompt: "s".repeat(140_000), cwd: "/tmp" } as any))
      .rejects.toThrow(/^Grok cannot be started with this turn: the system prompt is 140,000 bytes, over the operating system's limit of 131,071 bytes/);
    expect(ptySpawns).toHaveLength(0);
    expect(engine.isTurnRunning("gk-big")).toBe(false);
  });

  it("spawns an oversized message, which is pasted rather than passed as an argument", async () => {
    void engine.run({ sessionId: "gk-msg", prompt: "m".repeat(136_066), systemPrompt: "persona", cwd: "/tmp" } as any);
    await flush();
    expect(ptySpawns).toHaveLength(1);
    const args = ptySpawns[0].args;
    expect(args[args.indexOf("--system-prompt-override") + 1]).toBe("persona");
    expect(args.some((a) => a.includes("m".repeat(1000)))).toBe(false);
  });

  it("reports a process that dies before its TUI is up as a failed start, with its output", async () => {
    const run = engine.run({ sessionId: "gk-dies", prompt: "hi", cwd: "/tmp" } as any);
    await flush();
    const proc = ptySpawns[0].proc;
    proc._emit("error: unexpected argument '--bogus' found\r\n");
    proc._exit(2);
    const result = await run;
    expect(result.error).toBe(processStartFailure("grok", { exitCode: 2, signal: 0 }, "error: unexpected argument '--bogus' found"));
  });

  it("still reports a started process's death as an interruption", async () => {
    const run = engine.run({ sessionId: "gk-started", prompt: "hi", cwd: "/tmp" } as any);
    await flush();
    const proc = ptySpawns[0].proc;
    proc._emit("Grok Build  always-approve\r\n❯ ");
    proc._exit(1);
    expect((await run).error).toBe("Interrupted: grok process exited (code 1, signal 0)");
  });
});

describe("headless engines — a prompt too long for one argument", () => {
  it("codex fails up front, naming the message, its size and the limit, and spawns nothing", async () => {
    const engine = new CodexEngine({ codexHomesBaseDir: osMockState.home });
    await expect(engine.run({ sessionId: "cx-headless", prompt: "p".repeat(136_066), cwd: "/tmp" } as any))
      .rejects.toThrow(/^Codex cannot be started with this turn: the message is 136,066 bytes, /);
    expect(childSpawns).toHaveLength(0);
  });

  it("codex on a resume names the platform context refresh folded into the message", async () => {
    const engine = new CodexEngine({ codexHomesBaseDir: osMockState.home });
    await expect(engine.run({
      sessionId: "cx-headless-resume", prompt: "p".repeat(136_066), resumeSessionId: "thread-1", platformContextRefresh: "refresh", cwd: "/tmp",
    } as any)).rejects.toThrow(/^Codex cannot be started with this turn: the message \(with the platform context refresh\) is 136,0\d\d bytes, /);
    expect(childSpawns).toHaveLength(0);
  });

  it("codex checks every argument, not only the message", async () => {
    const engine = new CodexEngine({ codexHomesBaseDir: osMockState.home });
    await expect(engine.run({ sessionId: "cx-headless-model", prompt: "hi", model: "m".repeat(140_000), cwd: "/tmp" } as any))
      .rejects.toThrow(/^Codex cannot be started with this turn: command-line argument 3 is 140,000 bytes, /);
    expect(childSpawns).toHaveLength(0);
  });

  it("grok fails up front, naming the message, its size and the limit, and spawns nothing", async () => {
    const engine = new GrokEngine();
    await expect(engine.run({ sessionId: "gk-headless", prompt: "p".repeat(136_066), systemPrompt: "persona", cwd: "/tmp" } as any))
      .rejects.toThrow(/^Grok cannot be started with this turn: the message \(with its system prompt\) is 136,0\d\d bytes, /);
    expect(childSpawns).toHaveLength(0);
  });

  it("grok on a resume names only the message", async () => {
    const engine = new GrokEngine();
    await expect(engine.run({ sessionId: "gk-headless-resume", prompt: "p".repeat(136_066), systemPrompt: "persona", resumeSessionId: "s1", cwd: "/tmp" } as any))
      .rejects.toThrow(/^Grok cannot be started with this turn: the message is 136,066 bytes, /);
    expect(childSpawns).toHaveLength(0);
  });
});
