import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as headless from "../antigravity-headless.js";

interface FakeProc extends EventEmitter {
  stdin: EventEmitter & { end: (text?: string) => void };
  stdout: EventEmitter;
  stderr: EventEmitter;
  exitCode: number | null;
  killed: boolean;
  pid: number;
  signals: NodeJS.Signals[];
  stdinWrites: string[];
  kill: (signal?: NodeJS.Signals) => boolean;
  unref: () => void;
  emitStdout: (text: string) => void;
  close: (code: number | null) => void;
}

interface SpawnCall {
  bin: string;
  args: string[];
  opts: unknown;
  proc: FakeProc;
}

const spawnCalls = vi.hoisted(() => [] as SpawnCall[]);

function makeFakeProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = new EventEmitter() as FakeProc["stdin"];
  proc.stdinWrites = [];
  proc.stdin.end = (text = "") => { proc.stdinWrites.push(text); };
  proc.exitCode = null;
  proc.killed = false;
  proc.pid = 63_630;
  proc.signals = [];
  proc.kill = (signal = "SIGTERM") => {
    proc.killed = true;
    proc.signals.push(signal);
    return true;
  };
  proc.unref = () => {};
  proc.emitStdout = (text) => proc.stdout.emit("data", Buffer.from(text));
  proc.close = (code) => {
    proc.exitCode = code;
    proc.emit("close", code);
  };
  return proc;
}

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn((bin: string, args: string[], opts: unknown) => {
    const proc = makeFakeProc();
    spawnCalls.push({ bin, args, opts, proc });
    return proc;
  }),
}));

beforeEach(() => {
  spawnCalls.length = 0;
  vi.spyOn(process, "kill").mockImplementation(() => true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("AntigravityHeadlessEngine process ownership", () => {
  it("runs a Windows npm shim through cmd.exe and kills its process tree", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const hostilePrompt = "say \"ok\" & echo %PATH% !value! ^ done";
    const engine = new headless.AntigravityHeadlessEngine();
    const resultPromise = engine.run({
      prompt: hostilePrompt,
      cwd: "C:\\workspace",
      bin: "C:\\tools\\agy.cmd",
      sessionId: "hundredfold-session-windows",
      resumeSessionId: "conversation-windows",
    });
    const call = spawnCalls[0]!;

    expect(call.bin).toMatch(/[\\/]System32[\\/]cmd\.exe$/);
    expect(call.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(call.args.join(" ")).not.toContain(hostilePrompt);
    expect(call.proc.stdinWrites).toEqual([
      `${JSON.stringify({ event: "user", message: { content: hostilePrompt } })}\n`,
    ]);
    engine.kill("hundredfold-session-windows", "test cleanup");
    expect(vi.mocked(execFileSync)).toHaveBeenCalledWith(
      expect.stringMatching(/[\\/]System32[\\/]taskkill\.exe$/),
      ["/pid", "63630", "/t", "/f"],
      expect.objectContaining({ windowsHide: true }),
    );
    call.proc.close(null);
    await expect(resultPromise).resolves.toMatchObject({ error: "Interrupted: test cleanup" });
  });

  it("terminates and settles a turn at the hard timeout", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.useFakeTimers();
    const processKill = vi.mocked(process.kill);
    const engine = new headless.AntigravityHeadlessEngine();
    const resultPromise = engine.run({
      prompt: "continue",
      cwd: "/workspace",
      sessionId: "hundredfold-session-6",
      resumeSessionId: "conversation-10",
    });
    const call = spawnCalls[0]!;

    await vi.advanceTimersByTimeAsync(headless.ANTIGRAVITY_TURN_TIMEOUT_MS - 1);
    expect(processKill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(processKill).toHaveBeenCalledWith(-63_630, "SIGTERM");
    call.proc.close(null);

    await expect(resultPromise).resolves.toEqual({
      sessionId: "conversation-10",
      result: "",
      error: "Antigravity turn timed out",
    });
  });

  it("reaps the owned process group after an explicit terminal result", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const processKill = vi.mocked(process.kill);
    const engine = new headless.AntigravityHeadlessEngine();
    const resultPromise = engine.run({
      prompt: "run checks",
      cwd: "/workspace",
      sessionId: "hundredfold-session-7",
    });
    const call = spawnCalls[0]!;
    call.proc.emitStdout(`${JSON.stringify({
      event: "result",
      result: {
        conversation_id: "conversation-11",
        status: "SUCCESS",
        response: "done",
        num_turns: 1,
        usage: { input_tokens: 1, output_tokens: 1, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 2 },
      },
    })}\n`);

    await expect(resultPromise).resolves.toMatchObject({
      sessionId: "conversation-11",
      result: "done",
    });
    expect(processKill).toHaveBeenCalledWith(-63_630, "SIGTERM");
  });
});
