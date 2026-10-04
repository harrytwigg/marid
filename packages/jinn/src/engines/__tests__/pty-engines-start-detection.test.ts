import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Whether an interactive codex or grok process "started" decides how its death
 * is reported: before it started, the turn never ran and fails with the
 * process's own output; after, it was interrupted. These cover the two places
 * that call was wrong:
 *
 * - a fresh codex that wrote its transcript and died inside the discovery and
 *   tail polls (the engine had not yet seen the transcript, so it called the
 *   death a failed start "with no output");
 * - an idle-spawned warm PTY that died during boot after a turn bound to it
 *   (every reused warm PTY was counted as started).
 */

interface FakePty {
  pid: number;
  _exitCode: number | null;
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
    pid: 8000 + ptySpawns.length,
    _exitCode: null,
    onData: (cb) => { dataCbs.push(cb); return { dispose: () => {} }; },
    onExit: (cb) => { exitCbs.push(cb); return { dispose: () => {} }; },
    on: () => {},
    kill: () => {},
    resize: () => {},
    write: () => {},
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

const osMockState = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fsm = await import("node:fs");
  const pathm = await import("node:path");
  osMockState.home = fsm.mkdtempSync(pathm.join(actual.tmpdir(), "pty-start-detection-home-"));
  const homedir = () => osMockState.home;
  return { ...actual, homedir, default: { ...((actual as any).default ?? actual), homedir } };
});

import { CodexInteractiveEngine } from "../codex-interactive.js";
import { GrokInteractiveEngine } from "../grok-interactive.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";
import { processStartFailure } from "../../shared/process-start.js";
import { isDeadSessionError } from "../../shared/rateLimit.js";

const flush = () => new Promise((r) => setTimeout(r, 20));
const sessionMeta = (id: string, cwd = "/tmp") => JSON.stringify({ type: "session_meta", payload: { id, cwd } }) + "\n";

let lifecycle: PtyLifecycleManager;
let sessionsDir: string;
let fileSeq = 0;

beforeEach(() => {
  ptySpawns.length = 0;
  lifecycle = new PtyLifecycleManager({ maxLivePtys: 10 });
  sessionsDir = path.join(osMockState.home, ".codex", "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  lifecycle.killAll();
});

describe("CodexInteractiveEngine — a process that dies right after writing its transcript", () => {
  let engine: CodexInteractiveEngine;
  beforeEach(() => { engine = new CodexInteractiveEngine(lifecycle); });

  it("is an interruption when a fresh session's transcript appeared before the polls saw it", async () => {
    const run = engine.run({ sessionId: "cx-fresh-dies", prompt: "hello", cwd: "/tmp" } as any);
    await flush();
    fs.writeFileSync(path.join(sessionsDir, `rollout-start-${++fileSeq}.jsonl`), sessionMeta("thread-fresh"));
    ptySpawns[0].proc._exit(1);
    const result = await run;
    expect(result.error).toBe("Interrupted: codex process exited (code 1, signal 0)");
  });

  it("is an interruption when a resumed session's transcript grew before the tail saw it", async () => {
    const transcript = path.join(sessionsDir, `rollout-start-${++fileSeq}.jsonl`);
    fs.writeFileSync(transcript, sessionMeta("thread-resumed"));
    const run = engine.run({ sessionId: "cx-resume-dies", prompt: "hello", resumeSessionId: "thread-resumed", cwd: "/tmp" } as any);
    await flush();
    fs.appendFileSync(transcript, JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "t1" } }) + "\n");
    ptySpawns[0].proc._exit(1);
    expect((await run).error).toBe("Interrupted: codex process exited (code 1, signal 0)");
  });

  it("is still a failed start when the new rollout is another process's: a different working directory", async () => {
    const run = engine.run({ sessionId: "cx-other-cwd", prompt: "hello", cwd: "/tmp" } as any);
    await flush();
    fs.writeFileSync(path.join(sessionsDir, `rollout-start-${++fileSeq}.jsonl`), sessionMeta("thread-other", "/somewhere/else"));
    ptySpawns[0].proc._exit(1);
    expect((await run).error).toBe(processStartFailure("codex", { exitCode: 1, signal: 0 }, ""));
  });

  it("is an interruption when the rollout records the same directory by another path", async () => {
    // macOS: /tmp is a symlink to /private/tmp, and the rollout may record either.
    const real = fs.realpathSync(osMockState.home);
    const link = `${osMockState.home}-link-${++fileSeq}`;
    fs.symlinkSync(real, link);
    const run = engine.run({ sessionId: "cx-linked-cwd", prompt: "hello", cwd: link } as any);
    await flush();
    fs.writeFileSync(path.join(sessionsDir, `rollout-start-${++fileSeq}.jsonl`), sessionMeta("thread-linked", real));
    ptySpawns[0].proc._exit(1);
    expect((await run).error).toBe("Interrupted: codex process exited (code 1, signal 0)");
  });

  it("is still a failed start when more than one new rollout appeared, so none is known to be its own", async () => {
    const run = engine.run({ sessionId: "cx-two-fresh", prompt: "hello", cwd: "/tmp" } as any);
    await flush();
    fs.writeFileSync(path.join(sessionsDir, `rollout-start-${++fileSeq}.jsonl`), sessionMeta("thread-a"));
    fs.writeFileSync(path.join(sessionsDir, `rollout-start-${++fileSeq}.jsonl`), sessionMeta("thread-b"));
    ptySpawns[0].proc._exit(1);
    expect((await run).error).toMatch(/^codex did not start: /);
  });

  it("is still a failed start, with the output, when no transcript was written", async () => {
    const run = engine.run({ sessionId: "cx-no-transcript", prompt: "hello", cwd: "/tmp" } as any);
    await flush();
    ptySpawns[0].proc._emit("error: unexpected argument '--bogus' found\r\n");
    ptySpawns[0].proc._exit(2);
    expect((await run).error).toBe(processStartFailure("codex", { exitCode: 2, signal: 0 }, "error: unexpected argument '--bogus' found"));
  });
});

describe("CodexInteractiveEngine — a resume id codex no longer has", () => {
  let engine: CodexInteractiveEngine;
  beforeEach(() => { engine = new CodexInteractiveEngine(lifecycle); });

  it("fails the start with the TUI's own sentence, on the resume id, so the id is dropped", async () => {
    const run = engine.run({ sessionId: "cx-gone", prompt: "hello", resumeSessionId: "thread-gone", cwd: "/tmp" } as any);
    await flush();
    expect(ptySpawns[0].args).toContain("resume");
    ptySpawns[0].proc._emit("\x1b[2J\x1b[HERROR: No saved session found with ID thread-gone. Run `codex resume` without an ID to choose from existing sessions.\r\n");
    ptySpawns[0].proc._exit(1);
    const result = await run;
    expect(result).toMatchObject({ sessionId: "thread-gone", error: expect.stringMatching(/^codex did not start: /) });
    expect(isDeadSessionError(result)).toBe(true);
  });
});

describe("CodexInteractiveEngine — a warm PTY that dies during boot", () => {
  let engine: CodexInteractiveEngine;
  beforeEach(() => { engine = new CodexInteractiveEngine(lifecycle); });

  it("fails the turn that bound to it as a failed start, with the output", async () => {
    engine.ensureIdleSpawn("cx-warm-boot", { cwd: "/tmp", model: "gpt-5.5" });
    ptySpawns[0].proc._emit("Error: no such model\r\n");
    const run = engine.run({ sessionId: "cx-warm-boot", prompt: "hello", cwd: "/tmp", model: "gpt-5.5" } as any);
    await flush();
    ptySpawns[0].proc._exit(1);
    expect((await run).error).toBe(processStartFailure("codex", { exitCode: 1, signal: 0 }, "Error: no such model"));
  });

  it("is a failed start however long it was warm, while no turn on it has started", async () => {
    const now = Date.now();
    engine.ensureIdleSpawn("cx-warm-old", { cwd: "/tmp", model: "gpt-5.5" });
    vi.spyOn(Date, "now").mockReturnValue(now + 60 * 60 * 1000);
    const run = engine.run({ sessionId: "cx-warm-old", prompt: "hello", cwd: "/tmp", model: "gpt-5.5" } as any);
    await flush();
    ptySpawns[0].proc._exit(1);
    expect((await run).error).toMatch(/^codex did not start: /);
  });

  it("is an interruption once an earlier turn on it started", async () => {
    engine.ensureIdleSpawn("cx-warm-used", { cwd: "/tmp", model: "gpt-5.5" });
    const first = engine.run({ sessionId: "cx-warm-used", prompt: "one", cwd: "/tmp", model: "gpt-5.5" } as any);
    await flush();
    fs.writeFileSync(path.join(sessionsDir, `rollout-start-${++fileSeq}.jsonl`), [
      sessionMeta("thread-used").trim(),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "t1" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "t1", last_agent_message: "done" } }),
    ].join("\n") + "\n");
    expect(await first).toMatchObject({ sessionId: "thread-used", result: "done" });

    const second = engine.run({ sessionId: "cx-warm-used", prompt: "two", resumeSessionId: "thread-used", cwd: "/tmp", model: "gpt-5.5" } as any);
    await flush();
    expect(ptySpawns).toHaveLength(1);
    ptySpawns[0].proc._exit(1);
    expect((await second).error).toBe("Interrupted: codex process exited (code 1, signal 0)");
  });
});

describe("GrokInteractiveEngine — a warm PTY that dies during boot", () => {
  let engine: GrokInteractiveEngine;
  beforeEach(() => { engine = new GrokInteractiveEngine(lifecycle); });

  it("fails the turn that bound to it as a failed start, with the output", async () => {
    engine.ensureIdleSpawn("gk-warm-boot", { cwd: "/tmp" });
    ptySpawns[0].proc._emit("error: failed to load config\r\n");
    const run = engine.run({ sessionId: "gk-warm-boot", prompt: "hi", cwd: "/tmp" } as any);
    await flush();
    ptySpawns[0].proc._exit(1);
    expect((await run).error).toBe(processStartFailure("grok", { exitCode: 1, signal: 0 }, "error: failed to load config"));
  });

  it("is an interruption once its TUI was up", async () => {
    engine.ensureIdleSpawn("gk-warm-up", { cwd: "/tmp" });
    ptySpawns[0].proc._emit("Grok Build  always-approve\r\n❯ ");
    const run = engine.run({ sessionId: "gk-warm-up", prompt: "hi", cwd: "/tmp" } as any);
    await flush();
    ptySpawns[0].proc._exit(1);
    expect((await run).error).toBe("Interrupted: grok process exited (code 1, signal 0)");
  });

});
