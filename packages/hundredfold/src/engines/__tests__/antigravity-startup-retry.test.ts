import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { setImmediate as realSetImmediate, setTimeout as realSetTimeout } from "node:timers";

interface FakePty {
  pid: number;
  cols: number;
  rows: number;
  _exitCode: number | null;
  writes: string[];
  onData: (cb: (data: string) => void) => { dispose: () => void };
  onExit: (cb: (event: { exitCode: number; signal: number }) => void) => void;
  on: (event: string, cb: (...args: unknown[]) => void) => void;
  kill: (signal?: string) => void;
  resize: (cols: number, rows: number) => void;
  write: (data: string) => void;
  emitData: (data: string) => void;
}

interface SpawnCall {
  proc: FakePty;
}

const spawnCalls: SpawnCall[] = [];

function makeFakePty(): FakePty {
  const dataCallbacks = new Set<(data: string) => void>();
  const proc: FakePty = {
    pid: 4242,
    cols: 120,
    rows: 40,
    _exitCode: null,
    writes: [],
    onData: (callback) => {
      dataCallbacks.add(callback);
      return { dispose: () => dataCallbacks.delete(callback) };
    },
    onExit: () => {},
    on: () => {},
    kill: () => { proc._exitCode = -1; },
    resize: (cols, rows) => { proc.cols = cols; proc.rows = rows; },
    write: (data) => { proc.writes.push(data); },
    emitData: (data) => { for (const callback of dataCallbacks) callback(data); },
  };
  return proc;
}

vi.mock("node-pty", () => ({
  spawn: vi.fn(() => {
    const proc = makeFakePty();
    spawnCalls.push({ proc });
    return proc as unknown as import("node-pty").IPty;
  }),
}));

const osMockState = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fsm = await import("node:fs");
  const pathm = await import("node:path");
  osMockState.home = fsm.mkdtempSync(pathm.join(actual.tmpdir(), "agy-startup-test-"));
  const homedir = () => osMockState.home;
  return { ...actual, homedir, default: { ...((actual as any).default ?? actual), homedir } };
});

import { AntigravityEngine } from "../antigravity.js";
import { transcriptPathFor } from "../antigravity-protocol.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";

const VERIFICATION_BANNER = [
  "\u001b[33mVerifying your account...\u001b[0m",
  "We're finishing verifying your account eligibility.",
  "Please try again shortly.",
].join("\r\n");

const engines: AntigravityEngine[] = [];

function makeEngine(): AntigravityEngine {
  const engine = new AntigravityEngine(new PtyLifecycleManager({ maxLivePtys: 2 }));
  engines.push(engine);
  return engine;
}

function brainDir(): string {
  return path.join(osMockState.home, ".gemini", "antigravity-cli", "brain");
}

function createAnswer(convId: string, answer: string): void {
  const transcriptPath = transcriptPathFor(convId);
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.writeFileSync(transcriptPath, `${JSON.stringify({
    step_index: 1,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    status: "DONE",
    content: answer,
  })}\n`);
}

// The engine reaches its answer through the transcript tailer's three sequential
// libuv reads (stat, then open, then read). Those complete on the threadpool and
// land in the loop's poll phase, so a step that yields a bare `setImmediate` buys
// a loop turn but no wall clock at all — the whole stepping budget can elapse in
// well under a millisecond, long before the first read returns. Alone that still
// passed; in a full run, with every other suite's fork contending for the same
// threadpool, it did not. A real millisecond per step is what makes this
// deterministic instead of load-dependent. `Date` and `hrtime` are faked here,
// but node:timers' setTimeout is not, so it is the one real clock available.
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await new Promise<void>((resolve) => realSetImmediate(resolve));
  await new Promise<void>((resolve) => realSetTimeout(resolve, 1));
}

// Small enough that a virtual budget also buys a generous real-I/O budget: the
// engine settles 1.5s of virtual time in, so 25ms steps leave the reads roughly
// twenty times the wall clock they need before the budget runs out.
const SETTLE_STEP_MS = 25;

async function settleWithTimers<T>(promise: Promise<T>, maxVirtualMs: number): Promise<T> {
  let settled = false;
  void promise.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  for (let elapsed = 0; !settled && elapsed < maxVirtualMs; elapsed += SETTLE_STEP_MS) {
    await advance(SETTLE_STEP_MS);
  }
  if (!settled) throw new Error(`Promise did not settle within ${maxVirtualMs}ms of virtual time`);
  return promise;
}

async function reachFirstSubmit(proc: FakePty): Promise<void> {
  proc.emitData("ready");
  await advance(1_500);
  expect(proc.writes).toHaveLength(1);
}

beforeEach(() => {
  vi.useFakeTimers();
  spawnCalls.length = 0;
  engines.length = 0;
  fs.rmSync(brainDir(), { recursive: true, force: true });
  fs.mkdirSync(brainDir(), { recursive: true });
});

afterEach(async () => {
  for (const engine of engines) engine.killAll();
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
});

describe("AntigravityEngine cold-start retry", () => {
  it("re-submits after account verification and completes from the discovered transcript", async () => {
    const engine = makeEngine();
    const resultPromise = engine.run({
      prompt: "Reply with ready",
      cwd: osMockState.home,
      sessionId: "cold-retry",
    });
    const proc = spawnCalls[0]!.proc;

    await reachFirstSubmit(proc);
    proc.emitData(VERIFICATION_BANNER);
    await advance(5_000);
    expect(proc.writes).toHaveLength(2);

    createAnswer("conversation-a", "ready");
    const result = await settleWithTimers(resultPromise, 10_000);
    expect(result).toMatchObject({
      sessionId: "conversation-a",
      result: "ready",
    });
  });

  it("never re-submits a blocker emitted after conversation discovery", async () => {
    const engine = makeEngine();
    const resultPromise = engine.run({
      prompt: "one turn",
      cwd: osMockState.home,
      sessionId: "discovery-guard",
    });
    const proc = spawnCalls[0]!.proc;

    await reachFirstSubmit(proc);
    proc.emitData(VERIFICATION_BANNER);
    await advance(5_000);
    expect(proc.writes).toHaveLength(2);

    fs.mkdirSync(path.join(brainDir(), "conversation-b"), { recursive: true });
    await advance(500);
    proc.emitData(VERIFICATION_BANNER);
    await advance(5_000);

    expect(proc.writes).toHaveLength(2);
    engine.kill("discovery-guard");
    await resultPromise;
  });

  it("does not retry a resumed conversation", async () => {
    const engine = makeEngine();
    const resultPromise = engine.run({
      prompt: "resume once",
      cwd: osMockState.home,
      sessionId: "resumed-turn",
      resumeSessionId: "existing-conversation",
    });
    const proc = spawnCalls[0]!.proc;

    await reachFirstSubmit(proc);
    proc.emitData(VERIFICATION_BANNER);
    await advance(5_000);

    expect(proc.writes).toHaveLength(1);
    engine.kill("resumed-turn");
    await resultPromise;
  });

  it("reports the last startup blocker after exhausting two retries", async () => {
    const engine = makeEngine();
    const resultPromise = engine.run({
      prompt: "will remain blocked",
      cwd: osMockState.home,
      sessionId: "blocked-timeout",
    });
    const proc = spawnCalls[0]!.proc;

    await reachFirstSubmit(proc);
    for (let attempt = 0; attempt < 3; attempt++) {
      proc.emitData(VERIFICATION_BANNER);
      await advance(5_000);
    }
    expect(proc.writes).toHaveLength(3);
    await advance(60_000);

    const result = await resultPromise;
    expect(result.error).toContain("finishing verifying your account eligibility");
    expect(result.error).toContain("try again shortly");
    expect(result.error).not.toBe("Antigravity: no conversation transcript appeared");
  });
});
