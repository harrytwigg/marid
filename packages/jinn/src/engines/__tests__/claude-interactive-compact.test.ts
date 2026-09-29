import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * `/compact` as a gateway turn (self-compaction's first queued turn, or an
 * operator typing it). It fires no Stop, so it used to settle only on the
 * native-command quiet window — capped at 90s, and blind to a summarizing
 * request still in flight. It now settles on Claude Code's PostCompact hook,
 * and a quiet PTY no longer ends it while the proxy still has that request
 * open. Driven through `engine.run` with the same fake PTY as the submit-wiring
 * suite; the upstream check is stubbed because the SSE proxy is.
 */

interface FakePty {
  pid: number;
  _exitCode: number | null;
  _exitCb?: (e: { exitCode: number }) => void;
  writes: string[];
  onData: (cb: (d: string) => void) => void;
  onExit: (cb: (e: { exitCode: number }) => void) => void;
  kill: (signal?: string) => void;
  write: (d: string) => void;
  resize: (c: number, r: number) => void;
  on: (event: string, cb: (...a: any[]) => void) => void;
  fireExit: () => void;
}

const ptys: FakePty[] = [];
function makeFakePty(): FakePty {
  const p: FakePty = {
    pid: 2000 + ptys.length,
    _exitCode: null,
    writes: [], // records instead of discarding — the CRs are the subject here
    onData() {},
    onExit(cb) { p._exitCb = cb; },
    kill() {},
    write(d: string) { p.writes.push(d); },
    resize() {},
    on() {},
    fireExit() { p._exitCode = 0; p._exitCb?.({ exitCode: 0 }); },
  };
  return p;
}

vi.mock("node-pty", () => ({
  spawn: vi.fn(() => { const p = makeFakePty(); ptys.push(p); return p; }),
}));
vi.mock("../sse-pty-proxy.js", () => ({
  MAIN_AGENT_SENTINEL: "<!-- jinn-main-agent:5c1f -->",
  SsePtyProxy: class {
    port = 0;
    constructor(_label: string, _onEvent: (e: unknown) => void) {}
    async start() { return 41100; }
    stop() {}
  },
}));
vi.mock("../shared/claude-settings.js", () => ({
  writeSessionSettings: () => "/tmp/fake-settings.json",
}));

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compactionStatsFromTranscript, InteractiveClaudeEngine, nativeCommandSettles } from "../claude-interactive.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";

/** A Claude Code transcript line: the boundary a finished `/compact` writes. */
function boundaryLine(at: number, trigger: string, preTokens: number, postTokens: number): string {
  return JSON.stringify({
    parentUuid: null, type: "system", subtype: "compact_boundary", content: "Conversation compacted",
    timestamp: new Date(at).toISOString(), compactMetadata: { trigger, preTokens, postTokens },
  });
}

function writeTranscript(lines: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-compact-"));
  const file = path.join(dir, "t.jsonl");
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

describe("InteractiveClaudeEngine — /compact turns", () => {
  let lifecycle: PtyLifecycleManager;
  let hookCb: ((h: any) => void) | undefined;
  let engine: InteractiveClaudeEngine;
  let upstream = false;
  /** A hook the registry had buffered before the turn registered: register()
   *  replays it synchronously, as the real registry does. */
  let replayOnRegister: any;

  beforeEach(() => {
    ptys.length = 0;
    hookCb = undefined;
    upstream = false;
    replayOnRegister = undefined;
    lifecycle = new PtyLifecycleManager({ maxLivePtys: 10 });
    const hookRegistry = {
      register: (_id: string, cb: (h: any) => void) => {
        hookCb = cb;
        const replay = replayOnRegister;
        replayOnRegister = undefined;
        if (replay) cb(replay);
      },
      unregister: () => {},
    } as any;
    engine = new InteractiveClaudeEngine(lifecycle, hookRegistry);
    vi.spyOn(engine as any, "hasActiveUpstream").mockImplementation(() => upstream);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function warm(sessionId: string): Promise<void> {
    const turn = engine.run({ sessionId, prompt: "first", cwd: "/tmp" } as any);
    await vi.advanceTimersByTimeAsync(20);
    hookCb!({ hook_event_name: "SessionStart", session_id: "c1" });
    hookCb!({ hook_event_name: "Stop", last_assistant_message: "done" });
    expect((await turn).error).toBeUndefined();
  }

  /** Resolves to the settled result, or "pending" if the turn has not settled. */
  function settledOrPending(turn: Promise<unknown>): Promise<unknown> {
    return Promise.race([turn, Promise.resolve("pending")]);
  }

  it("settles on a live PostCompact, empty, well inside the quiet-window minimum", async () => {
    vi.useFakeTimers();
    await warm("s-post");
    upstream = true;
    const turn = engine.run({ sessionId: "s-post", prompt: "/compact keep the ids", cwd: "/tmp" } as any);
    await vi.advanceTimersByTimeAsync(500);
    expect(await settledOrPending(turn)).toBe("pending");
    hookCb!({ hook_event_name: "PreCompact", trigger: "manual" });
    hookCb!({ hook_event_name: "SessionStart", source: "compact", session_id: "c1" });
    hookCb!({ hook_event_name: "PostCompact", trigger: "manual", compact_summary: "<analysis>…" });
    await vi.advanceTimersByTimeAsync(10);
    const result = await turn as { result: string; error?: string };
    expect(result.error).toBeUndefined();
    // The summary is never the turn's reply.
    expect(result.result).toBe("");
  });

  it("does not settle on a quiet PTY while the summarizing request is still open", async () => {
    vi.useFakeTimers();
    await warm("s-busy");
    upstream = true;
    const turn = engine.run({ sessionId: "s-busy", prompt: "/compact", cwd: "/tmp" } as any);
    // Far past the 90s every other native command is capped at.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(await settledOrPending(turn)).toBe("pending");
    // An auto-compaction's PostCompact is not the one this turn asked for.
    hookCb!({ hook_event_name: "PostCompact", trigger: "auto" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await settledOrPending(turn)).toBe("pending");
    // The request closes without the hook (lost): the quiet window takes it.
    upstream = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await turn as { error?: string }).error).toBeUndefined();
  });

  it("ignores a PostCompact replayed from before the turn registered", async () => {
    vi.useFakeTimers();
    await warm("s-replay");
    upstream = true;
    // An earlier compaction's PostCompact, still in the registry's buffer.
    replayOnRegister = { hook_event_name: "PostCompact", trigger: "manual" };
    const turn = engine.run({ sessionId: "s-replay", prompt: "/compact", cwd: "/tmp" } as any);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await settledOrPending(turn)).toBe("pending");
    hookCb!({ hook_event_name: "PostCompact", trigger: "manual" });
    await vi.advanceTimersByTimeAsync(10);
    expect((await turn as { error?: string }).error).toBeUndefined();
  });

  it("is still bounded if both the hook and the request's end are lost", async () => {
    vi.useFakeTimers();
    await warm("s-bound");
    upstream = true;
    const turn = engine.run({ sessionId: "s-bound", prompt: "/compact", cwd: "/tmp" } as any);
    await vi.advanceTimersByTimeAsync(14 * 60_000);
    expect(await settledOrPending(turn)).toBe("pending");
    await vi.advanceTimersByTimeAsync(61_000);
    expect((await turn as { error?: string }).error).toBeUndefined();
  });

  it("reports the compaction it confirmed, with the transcript's sizes, and meters the size after", async () => {
    vi.useFakeTimers();
    await warm("s-stats");
    upstream = true;
    const turn = engine.run({ sessionId: "s-stats", prompt: "/compact keep the ids", cwd: "/tmp" } as any);
    await vi.advanceTimersByTimeAsync(500);
    const now = Date.now();
    const transcript = writeTranscript([
      boundaryLine(now - 3_600_000, "manual", 90_000, 5_000), // an earlier /compact
      JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 10, cache_read_input_tokens: 23_000 } } }),
      boundaryLine(now + 100, "manual", 23_058, 2_706),
    ]);
    hookCb!({ hook_event_name: "PostCompact", trigger: "manual", transcript_path: transcript });
    await vi.advanceTimersByTimeAsync(10);
    const result = await turn as { result: string; error?: string; compaction?: unknown; contextTokens?: number };
    expect(result.error).toBeUndefined();
    expect(result.result).toBe("");
    expect(result.compaction).toEqual({ preTokens: 23_058, postTokens: 2_706 });
    expect(result.contextTokens).toBe(2_706);
  });

  it("waits for the compact_boundary Claude Code writes just after PostCompact (live race)", async () => {
    vi.useFakeTimers();
    await warm("s-race");
    upstream = true;
    const turn = engine.run({ sessionId: "s-race", prompt: "/compact", cwd: "/tmp" } as any);
    await vi.advanceTimersByTimeAsync(500);
    // PostCompact fires first; the boundary lands in the transcript after it.
    const transcript = writeTranscript([
      JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 10, cache_read_input_tokens: 37_000 } } }),
    ]);
    hookCb!({ hook_event_name: "PostCompact", trigger: "manual", transcript_path: transcript });
    setTimeout(() => fs.appendFileSync(transcript, boundaryLine(Date.now(), "manual", 37_726, 3_392) + "\n"), 300);
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await turn as { compaction?: unknown; contextTokens?: number };
    expect(result.compaction).toEqual({ preTokens: 37_726, postTokens: 3_392 });
    expect(result.contextTokens).toBe(3_392);
  });

  it("gives up on a boundary that never comes, and still confirms the compaction", async () => {
    vi.useFakeTimers();
    await warm("s-noboundary");
    upstream = true;
    const turn = engine.run({ sessionId: "s-noboundary", prompt: "/compact", cwd: "/tmp" } as any);
    await vi.advanceTimersByTimeAsync(500);
    hookCb!({ hook_event_name: "PostCompact", trigger: "manual", transcript_path: writeTranscript(["{}"]) });
    await vi.advanceTimersByTimeAsync(2_500);
    expect((await turn as { compaction?: unknown }).compaction).toEqual({});
  });

  it("still confirms a compaction whose transcript it cannot read, just without sizes", async () => {
    vi.useFakeTimers();
    await warm("s-remote");
    upstream = true;
    const turn = engine.run({ sessionId: "s-remote", prompt: "/compact", cwd: "/tmp" } as any);
    await vi.advanceTimersByTimeAsync(500);
    hookCb!({ hook_event_name: "PostCompact", trigger: "manual", transcript_path: "/nonexistent/on-another-host.jsonl" });
    await vi.advanceTimersByTimeAsync(10);
    const result = await turn as { compaction?: unknown; contextTokens?: number };
    expect(result.compaction).toEqual({});
    expect(result.contextTokens).toBeUndefined();
  });

  it("claims no compaction for a /compact that settled without PostCompact", async () => {
    vi.useFakeTimers();
    await warm("s-unconfirmed");
    upstream = false;
    const turn = engine.run({ sessionId: "s-unconfirmed", prompt: "/compact", cwd: "/tmp" } as any);
    await vi.advanceTimersByTimeAsync(6_000);
    const result = await turn as { error?: string; compaction?: unknown };
    expect(result.error).toBeUndefined();
    expect(result.compaction).toBeUndefined();
  });

  it("leaves every other native command on the plain quiet window", async () => {
    vi.useFakeTimers();
    await warm("s-model");
    upstream = true;
    const turn = engine.run({ sessionId: "s-model", prompt: "/model opus", cwd: "/tmp" } as any);
    await vi.advanceTimersByTimeAsync(4_000);
    expect((await turn as { error?: string }).error).toBeUndefined();
  });
});

describe("nativeCommandSettles", () => {
  const base = { compact: false, elapsedMs: 5_000, quietForMs: 5_000, upstreamActive: false };
  it("keeps the existing rule for ordinary native commands", () => {
    expect(nativeCommandSettles(base)).toBe(true);
    expect(nativeCommandSettles({ ...base, elapsedMs: 2_000 })).toBe(false);
    expect(nativeCommandSettles({ ...base, quietForMs: 1_000 })).toBe(false);
    expect(nativeCommandSettles({ ...base, upstreamActive: true })).toBe(true);
    expect(nativeCommandSettles({ ...base, quietForMs: 0, elapsedMs: 90_000 })).toBe(true);
  });
  it("holds /compact open while its request is in flight, up to its own longer bound", () => {
    const compact = { ...base, compact: true };
    expect(nativeCommandSettles(compact)).toBe(true);
    expect(nativeCommandSettles({ ...compact, upstreamActive: true })).toBe(false);
    expect(nativeCommandSettles({ ...compact, upstreamActive: true, elapsedMs: 90_000 })).toBe(false);
    expect(nativeCommandSettles({ ...compact, upstreamActive: true, elapsedMs: 15 * 60_000 })).toBe(true);
  });
});

describe("compactionStatsFromTranscript", () => {
  const t0 = Date.parse("2026-09-29T08:00:00.000Z");

  it("takes the newest manual boundary at or after the turn started", () => {
    const file = writeTranscript([
      boundaryLine(t0 - 1, "manual", 1_000, 100),
      boundaryLine(t0 + 5, "manual", 50_000, 4_000),
      boundaryLine(t0 + 9, "auto", 900_000, 9_000),
      "not json",
    ]);
    expect(compactionStatsFromTranscript(file, t0)).toEqual({ preTokens: 50_000, postTokens: 4_000 });
  });

  it("is empty when the only boundary predates the turn, or is an auto-compaction", () => {
    expect(compactionStatsFromTranscript(writeTranscript([boundaryLine(t0 - 1, "manual", 1_000, 100)]), t0)).toEqual({});
    expect(compactionStatsFromTranscript(writeTranscript([boundaryLine(t0 + 1, "auto", 1_000, 100)]), t0)).toEqual({});
  });

  it("is empty for a transcript it cannot read", () => {
    expect(compactionStatsFromTranscript("/nonexistent/t.jsonl", t0)).toEqual({});
  });

  /**
   * Against a transcript a real Claude Code `/compact` wrote. Skipped unless
   * CLAUDE_COMPACT_TRANSCRIPT names one:
   *
   *   CLAUDE_COMPACT_TRANSCRIPT=~/.claude/projects/<slug>/<session>.jsonl \
   *   pnpm exec vitest run src/engines/__tests__/claude-interactive-compact.test.ts
   */
  it.skipIf(!process.env.CLAUDE_COMPACT_TRANSCRIPT)("reads a real Claude Code compact_boundary", () => {
    const stats = compactionStatsFromTranscript(process.env.CLAUDE_COMPACT_TRANSCRIPT!, 0);
    console.log(`live compact_boundary: ${JSON.stringify(stats)}`);
    expect(stats.preTokens).toBeGreaterThan(stats.postTokens ?? Infinity);
    expect(stats.postTokens).toBeGreaterThan(0);
  });
});
