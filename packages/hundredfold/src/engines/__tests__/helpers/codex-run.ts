import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect } from "vitest";
import { CodexEngine, type CodexEngineOpts } from "../../codex.js";
import type { StreamDelta, EngineResult } from "../../../shared/types.js";

/** Fakes and fixtures shared by the codex suites. codex.ts spawns the CLI via
 *  node:child_process `spawn`, so the smallest seam onto its parsing pipeline is
 *  a fake ChildProcess whose stdout the test drives line by line. No real process
 *  is ever spawned. `vi.mock` is hoisted per file, so each suite declares the
 *  mock itself and calls `recordSpawn` from the factory. */

// A controllable fake ChildProcess. Each spawn() pushes one here and records the
// args it was called with, so tests can assert on what got passed to the CLI and
// drive stdout/stderr/close deterministically.
export interface FakeProc {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { end: () => void };
  exitCode: number | null;
  killed: boolean;
  kill: (sig?: string) => boolean;
  pid: number;
  on: (event: string, cb: (...a: any[]) => void) => FakeProc;
  _handlers: Record<string, (...a: any[]) => void>;
  /** Feed a chunk of stdout (may contain partial lines). */
  emitStdout: (s: string) => void;
  emitStderr: (s: string) => void;
  /** Fire the "close" event with an exit code. */
  close: (code: number | null) => void;
}

export interface SpawnCall {
  bin: string;
  args: string[];
  opts: unknown;
  proc: FakeProc;
}

export const spawnCalls: SpawnCall[] = [];

export function makeFakeProc(): FakeProc {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const handlers: Record<string, (...a: any[]) => void> = {};
  const p: FakeProc = {
    stdout,
    stderr,
    stdin: { end: () => {} },
    exitCode: null,
    killed: false,
    pid: 4242,
    kill: () => true,
    _handlers: handlers,
    on(event, cb) {
      handlers[event] = cb;
      return p;
    },
    emitStdout(s) {
      stdout.emit("data", Buffer.from(s));
    },
    emitStderr(s) {
      stderr.emit("data", Buffer.from(s));
    },
    close(code) {
      p.exitCode = code;
      handlers["close"]?.(code);
    },
  };
  return p;
}

/** Stand in for one `spawn()` call: builds the fake child and records the args
 *  the CLI was invoked with, so a suite can assert on both. */
export function recordSpawn(bin: string, args: string[], opts: unknown): FakeProc {
  const proc = makeFakeProc();
  spawnCalls.push({ bin, args, opts, proc });
  return proc;
}

/** Forget the spawns of the previous test. */
export function resetSpawnCalls(): void {
  spawnCalls.length = 0;
}

export const flush = () => new Promise((r) => setTimeout(r, 0));
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// JSONL line builders mirroring the codex CLI `--json` event shapes.
export const threadStarted = (id: string) => JSON.stringify({ type: "thread.started", thread_id: id });
export const agentMessage = (text: string) =>
  JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } });
export const turnCompleted = (usage: Record<string, unknown>) =>
  JSON.stringify({ type: "turn.completed", usage });
export const turnFailed = (message: string) =>
  JSON.stringify({ type: "turn.failed", error: { message } });
export const errorItem = (message: string) =>
  JSON.stringify({ type: "item.completed", item: { type: "error", message } });
export const cmdStart = (id: string, command: string) =>
  JSON.stringify({ type: "item.started", item: { type: "command_execution", id, command } });
export const cmdEnd = (command: string, exit_code: number, output: string) =>
  JSON.stringify({
    type: "item.completed",
    item: { type: "command_execution", command, exit_code, aggregated_output: output },
  });

/**
 * Drive a full run: kick off engine.run, feed stdout lines, then close.
 * Returns the resolved EngineResult and the deltas captured via onStream.
 */
export async function runWith(
  opts: Record<string, unknown>,
  stdoutLines: string[],
  {
    closeCode = 0,
    trailingNoNewline,
    engineOpts,
  }: { closeCode?: number | null; trailingNoNewline?: string; engineOpts?: CodexEngineOpts } = {},
): Promise<{ result: EngineResult; deltas: StreamDelta[]; call: SpawnCall }> {
  const deltas: StreamDelta[] = [];
  const safeEngineOpts = {
    codexSessionsDir: fs.mkdtempSync(path.join(os.tmpdir(), "codex-test-sessions-")),
    ...engineOpts,
  };
  const engine = new CodexEngine(safeEngineOpts);
  const promise = engine.run({
    prompt: "hello",
    cwd: "/tmp",
    onStream: (d: StreamDelta) => deltas.push(d),
    ...opts,
  } as any);

  await flush();
  const call = spawnCalls[spawnCalls.length - 1];
  expect(call).toBeDefined();

  // Feed each complete line (with newline). Multiple lines in one chunk is fine.
  if (stdoutLines.length) call.proc.emitStdout(stdoutLines.join("\n") + "\n");
  // Optionally leave a trailing line WITHOUT a newline to exercise the
  // close-time lineBuf flush.
  if (trailingNoNewline) call.proc.emitStdout(trailingNoNewline);

  call.proc.close(closeCode);
  const result = await promise;
  return { result, deltas, call };
}
