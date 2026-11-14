import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as headless from "../antigravity-headless.js";
import { readAntigravityPrintModeError } from "../antigravity-cli-log.js";
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
  emitStderr: (text: string) => void;
  close: (code: number | null) => void;
  exit: (code: number | null) => void;
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
  proc.emitStderr = (text) => proc.stderr.emit("data", Buffer.from(text));
  proc.close = (code) => {
    proc.exitCode = code;
    proc.emit("close", code);
  };
  proc.exit = (code) => {
    proc.exitCode = code;
    proc.emit("exit", code);
  };
  return proc;
}

vi.mock("../antigravity-cli-log.js", () => ({
  readAntigravityPrintModeError: vi.fn(() => undefined),
}));

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
  vi.mocked(readAntigravityPrintModeError).mockReturnValue(undefined);
  vi.spyOn(process, "kill").mockImplementation(() => true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("AntigravityHeadlessEngine", () => {
  it("settles an explicit upstream error without waiting for process close", async () => {
    const engine = new headless.AntigravityHeadlessEngine();
    const resultPromise = engine.run({ prompt: "continue", cwd: "/workspace", sessionId: "hundredfold-session-1" });
    const call = spawnCalls[0]!;
    call.proc.emitStdout(`${JSON.stringify({
      event: "result",
      result: {
        conversation_id: "conversation-5",
        status: "ERROR",
        response: "",
        error: "There was a network issue connecting to the server.",
        duration_seconds: 2.5,
        num_turns: 1,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          thinking_tokens: 0,
          cache_read_tokens: 0,
          total_tokens: 0,
        },
      },
    })}\n`);

    await expect(resultPromise).resolves.toEqual({
      sessionId: "conversation-5",
      result: "",
      error: "There was a network issue connecting to the server.",
    });
    expect(engine.isAlive("hundredfold-session-1")).toBe(false);
  });

  it("keeps managed-task tool updates pending until the terminal result", async () => {
    const deltas: unknown[] = [];
    const engine = new headless.AntigravityHeadlessEngine();
    const resultPromise = engine.run({
      prompt: "run checks",
      cwd: "/workspace",
      sessionId: "hundredfold-session-2",
      onStream: (delta) => deltas.push(delta),
    });
    const call = spawnCalls[0]!;
    let settled = false;
    void resultPromise.then(() => { settled = true; });

    call.proc.emitStdout([
      JSON.stringify({
        event: "init",
        conversation_id: "conversation-6",
        init: { tools: ["manage_task"] },
      }),
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "conversation-6",
          step_index: 3,
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "manage_task",
          tool_info: { name: "manage_task", parameters: { Action: "status" } },
        },
      }),
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "conversation-6",
          step_index: 3,
          state: "DONE",
          step_type: "tool",
          tool_name: "manage_task",
          tool_info: { name: "manage_task", output: "Task completed." },
        },
      }),
      "",
    ].join("\n"));
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(deltas).toEqual([
      { type: "tool_use", content: "Using manage_task", toolName: "manage_task", toolId: "3" },
      { type: "tool_result", content: "manage_task done", toolName: "manage_task", toolId: "3" },
    ]);

    call.proc.emitStdout(`${JSON.stringify({
      event: "result",
      result: {
        conversation_id: "conversation-6",
        status: "SUCCESS",
        response: "All checks passed.",
        num_turns: 1,
        usage: { input_tokens: 10, output_tokens: 2, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 12 },
      },
    })}\n`);

    await expect(resultPromise).resolves.toEqual({
      sessionId: "conversation-6",
      result: "All checks passed.",
      numTurns: 1,
      contextTokens: 10,
    });
  });

  it("settles with a diagnostic when the process closes without a terminal result", async () => {
    const engine = new headless.AntigravityHeadlessEngine();
    const resultPromise = engine.run({
      prompt: "continue",
      cwd: "/workspace",
      sessionId: "hundredfold-session-3",
      resumeSessionId: "conversation-7",
    });
    const call = spawnCalls[0]!;
    call.proc.emitStderr("upstream transport failed\n");
    call.proc.close(1);

    const raced = await Promise.race([
      resultPromise,
      new Promise<"TIMED_OUT">((resolve) => setTimeout(() => resolve("TIMED_OUT"), 100)),
    ]);
    expect(raced).toEqual({
      sessionId: "conversation-7",
      result: "",
      error: "Antigravity exited with code 1: upstream transport failed",
    });
    expect(engine.isAlive("hundredfold-session-3")).toBe(false);
  });

  it("quotes agy's own diagnostic when it gave up without a terminal result", async () => {
    vi.mocked(readAntigravityPrintModeError).mockReturnValue("Print mode: timed out after 1482 polls");
    const engine = new headless.AntigravityHeadlessEngine();
    const resultPromise = engine.run({
      prompt: "continue",
      cwd: "/workspace",
      sessionId: "hundredfold-session-print-timeout",
      resumeSessionId: "conversation-print-timeout",
    });
    spawnCalls[0]!.proc.close(1);

    await expect(resultPromise).resolves.toEqual({
      sessionId: "conversation-print-timeout",
      result: "",
      error: "Antigravity exited with code 1 without a terminal result."
        + " agy reported: Print mode: timed out after 1482 polls",
    });
  });

  it("reaps descendants and ignores late output when the leader exits with an inherited pipe", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.useFakeTimers();
    const processKill = vi.mocked(process.kill);
    const deltas: unknown[] = [];
    const engine = new headless.AntigravityHeadlessEngine();
    const resultPromise = engine.run({
      prompt: "continue",
      cwd: "/workspace",
      sessionId: "hundredfold-session-4",
      resumeSessionId: "conversation-8",
      onStream: (delta) => deltas.push(delta),
    });
    const call = spawnCalls[0]!;
    call.proc.emitStderr("process exited unexpectedly\n");
    call.proc.exit(1);

    let settled = false;
    void resultPromise.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(1_499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(resultPromise).resolves.toEqual({
      sessionId: "conversation-8",
      result: "",
      error: "Antigravity exited with code 1: process exited unexpectedly",
    });
    expect(processKill).toHaveBeenCalledWith(-63_630, "SIGTERM");

    call.proc.emitStdout(`${JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "conversation-8",
        step_index: 9,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "manage_task",
      },
    })}\n`);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(processKill).toHaveBeenCalledWith(-63_630, "SIGKILL");
    expect(deltas).toEqual([]);
  });

  it("interrupts only the tracked process group and reports the reason", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const processKill = vi.mocked(process.kill);
    const engine = new headless.AntigravityHeadlessEngine();
    const resultPromise = engine.run({
      prompt: "continue",
      cwd: "/workspace",
      sessionId: "hundredfold-session-5",
      resumeSessionId: "conversation-9",
    });
    const call = spawnCalls[0]!;
    const kill = (engine as unknown as {
      kill?: (sessionId: string, reason?: string) => void;
    }).kill;
    kill?.call(engine, "hundredfold-session-5", "requested by supervisor");

    expect(processKill).toHaveBeenCalledWith(-63_630, "SIGTERM");
    call.proc.close(null);
    await expect(resultPromise).resolves.toEqual({
      sessionId: "conversation-9",
      result: "",
      error: "Interrupted: requested by supervisor",
    });
  });

});
