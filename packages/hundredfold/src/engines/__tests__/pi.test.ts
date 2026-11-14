import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EngineResult } from "../../shared/types.js";
import { makeFakeProc, flush, agentEnd, type SpawnCall } from "./support/pi-spawn-harness.js";

const spawnCalls: SpawnCall[] = [];

vi.mock("node:child_process", () => ({
  spawn: vi.fn((bin: string, args: string[], opts: unknown) => {
    const proc = makeFakeProc();
    spawnCalls.push({ bin, args, opts, proc });
    return proc;
  }),
}));

import { PiEngine } from "../pi.js";

async function startRun(): Promise<{ engine: PiEngine; promise: Promise<EngineResult>; call: SpawnCall }> {
  const engine = new PiEngine();
  const promise = engine.run({
    prompt: "hello",
    cwd: "/tmp",
    sessionId: "hundredfold-pi-1",
    model: "ollama/gemma4:12b",
  });
  await flush();
  const call = spawnCalls[spawnCalls.length - 1]!;
  expect(call).toBeDefined();
  return { engine, promise, call };
}

async function startStreamingRun(onStream: (delta: import("../../shared/types.js").StreamDelta) => void) {
  const engine = new PiEngine();
  const promise = engine.run({
    prompt: "hello",
    cwd: "/tmp",
    sessionId: "hundredfold-pi-stream",
    model: "ollama/gemma4:12b",
    onStream,
  });
  await flush();
  return { promise, call: spawnCalls[spawnCalls.length - 1]! };
}

beforeEach(() => {
  spawnCalls.length = 0;
});

describe("PiEngine lifecycle", () => {

  it("correlates a successful MCP receipt with the native Pi tool id", async () => {
    const deltas: import("../../shared/types.js").StreamDelta[] = [];
    const { promise, call } = await startStreamingRun((delta) => deltas.push(delta));
    call.proc.emitStdout(JSON.stringify({
      type: "tool_execution_end",
      toolName: "update_work_item",
      toolCallId: "call-1",
      result: { content: [{ type: "text", text: '{"activityReceiptId":"todo:wi_release"}' }] },
    }) + "\n");
    call.proc.emitStdout(agentEnd("done") + "\n");
    await flush();
    call.proc.close(0);
    await promise;

    expect(deltas).toContainEqual({
      type: "tool_result",
      content: '{"activityReceiptId":"todo:wi_release"}',
      toolName: "update_work_item",
      toolId: "call-1",
      activityReceiptId: "todo:wi_release",
    });
  });

  it("records agent_end output but resolves only after the process closes", async () => {
    const { promise, call } = await startRun();
    let settled = false;
    void promise.then(() => { settled = true; });

    call.proc.emitStdout(agentEnd("final answer") + "\n");
    await flush();
    expect(settled).toBe(false);

    call.proc.close(0);
    const result = await promise;
    expect(result).toMatchObject({ sessionId: "hundredfold-pi-1", result: "final answer" });
    expect(result.error).toBeUndefined();
  });

  it("treats exit 0 with no final assistant response as an error", async () => {
    const { promise, call } = await startRun();
    call.proc.close(0);

    const result = await promise;
    expect(result.result).toBe("");
    expect(result.error).toMatch(/without a final assistant response/);
  });

  it("does not return partial text as the result when interrupted", async () => {
    const { engine, promise, call } = await startRun();
    call.proc.emitStdout(agentEnd("partial") + "\n");
    await flush();

    engine.kill("hundredfold-pi-1", "Interrupted: user stopped");
    call.proc.close(null);
    const result = await promise;
    expect(result.result).toBe("");
    expect(result.error).toBe("Interrupted: user stopped");
  });
});

/**
 * Pi's parser reads any dash-leading argv token as an option — `pi "- "` exits with
 * `Error: Unknown option: -` — and it has no `--` separator (it reports `--` itself
 * as an unknown option). Its documented escape hatch is stdin, which pi consumes as
 * the message when no positional prompt is present.
 */
describe("PiEngine — prompt delivery over stdin", () => {
  async function runWithPrompt(prompt: string) {
    const engine = new PiEngine();
    const promise = engine.run({ prompt, cwd: "/tmp", sessionId: "hundredfold-pi-dash", model: "ollama/gemma4:12b" });
    await flush();
    const call = spawnCalls[spawnCalls.length - 1]!;
    return { promise, call };
  }

  it.each(["- ", "-p do the thing", "--json output please", "-"])(
    "keeps the dash-leading prompt %j off argv and writes it to stdin",
    async (prompt) => {
      const { promise, call } = await runWithPrompt(prompt);
      expect(call.args).not.toContain(prompt);
      expect(call.proc.stdinWrites.join("")).toBe(prompt);
      expect(call.proc.stdinEnded).toBe(true);
      call.proc.emitStdout(agentEnd("ok") + "\n");
      await flush();
      call.proc.close(0);
      await promise;
    },
  );

  it("still delivers an ordinary prompt, and never as a trailing positional", async () => {
    const { promise, call } = await runWithPrompt("hello there");
    expect(call.args).not.toContain("hello there");
    expect(call.proc.stdinWrites.join("")).toBe("hello there");
    call.proc.emitStdout(agentEnd("ok") + "\n");
    await flush();
    call.proc.close(0);
    await promise;
  });
});
