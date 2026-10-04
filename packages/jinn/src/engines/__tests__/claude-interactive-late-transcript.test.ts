import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Claude Code fires Stop before it has flushed the turn's last assistant
 * entries to the transcript. A turn that read the transcript once at Stop could
 * miss the whole of a short answer: it settled with no cost, and the context
 * meter kept the PREVIOUS turn's size. Under the auto-compaction floor while
 * the real context was over it, that stale meter made the next cold turn skip
 * its compaction. Seen live mostly on short turns answering a notification.
 */

interface FakePty {
  pid: number;
  _exitCode: number | null;
  _exitCb?: (e: { exitCode: number }) => void;
  onData: (cb: (d: string) => void) => void;
  onExit: (cb: (e: { exitCode: number }) => void) => void;
  kill: (signal?: string) => void;
  write: (d: string) => void;
  resize: (c: number, r: number) => void;
  on: (event: string, cb: (...a: any[]) => void) => void;
}

vi.mock("node-pty", () => ({
  spawn: vi.fn((): FakePty => {
    const p: FakePty = {
      pid: 3000,
      _exitCode: null,
      onData() {},
      onExit(cb) { p._exitCb = cb; },
      kill() {},
      write() {},
      resize() {},
      on() {},
    };
    return p;
  }),
}));
vi.mock("../sse-pty-proxy.js", () => ({
  MAIN_AGENT_SENTINEL: "<!-- jinn-main-agent:5c1f -->",
  SsePtyProxy: class {
    port = 0;
    constructor(_label: string, _onEvent: (e: unknown) => void) {}
    async start() { return 41200; }
    stop() {}
  },
}));
vi.mock("../shared/claude-settings.js", () => ({
  writeSessionSettings: () => "/tmp/fake-settings.json",
}));

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { InteractiveClaudeEngine, transcriptHasTurnAnswer } from "../claude-interactive.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";

/** An assistant transcript line with `context` tokens of input. */
function assistantLine(at: number, id: string, context: number, text?: string): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: new Date(at).toISOString(),
    message: {
      id,
      model: "claude-opus-5",
      content: text === undefined ? [{ type: "thinking", thinking: "…" }] : [{ type: "text", text }],
      usage: { input_tokens: 5, cache_read_input_tokens: context - 5, cache_creation_input_tokens: 0, output_tokens: 40 },
    },
  });
}

function writeTranscript(lines: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-late-transcript-"));
  const file = path.join(dir, "t.jsonl");
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

describe("InteractiveClaudeEngine — a Stop that beats the transcript", () => {
  let hookCb: ((h: any) => void) | undefined;
  let engine: InteractiveClaudeEngine;

  beforeEach(() => {
    vi.useFakeTimers();
    hookCb = undefined;
    const hookRegistry = { register: (_id: string, cb: (h: any) => void) => { hookCb = cb; }, unregister: () => {} } as any;
    engine = new InteractiveClaudeEngine(new PtyLifecycleManager({ maxLivePtys: 10 }), hookRegistry);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A turn on a session whose last answer, an hour ago, left 94k tokens of context. */
  async function turnWithEarlierAnswer(sessionId: string) {
    const transcript = writeTranscript([assistantLine(Date.now() - 3_600_000, "msg-earlier", 94_000, "earlier answer")]);
    const turn = engine.run({ sessionId, prompt: "any news?", cwd: "/tmp", model: "claude-opus-5" } as any);
    await vi.advanceTimersByTimeAsync(20);
    hookCb!({ hook_event_name: "SessionStart", session_id: "c1" });
    await vi.advanceTimersByTimeAsync(500);
    return { transcript, turn: turn as Promise<{ error?: string; result: string; cost?: number; contextTokens?: number }> };
  }

  it("waits for the answer to reach the transcript, then meters and costs THIS turn", async () => {
    const { transcript, turn } = await turnWithEarlierAnswer("s-late");
    hookCb!({ hook_event_name: "Stop", transcript_path: transcript, last_assistant_message: "no news yet" });
    // Claude Code writes the turn's entries just after the Stop.
    setTimeout(() => fs.appendFileSync(transcript, [
      assistantLine(Date.now(), "msg-now", 107_000),
      assistantLine(Date.now(), "msg-now", 107_000, "no news yet"),
    ].join("\n") + "\n"), 150);
    await vi.advanceTimersByTimeAsync(400);

    const result = await turn;
    expect(result.error).toBeUndefined();
    expect(result.result).toBe("no news yet");
    expect(result.contextTokens).toBe(107_000);
    expect(result.cost).toBeGreaterThan(0);
  });

  it("does not wait when the answer is already on disk", async () => {
    const { transcript, turn } = await turnWithEarlierAnswer("s-flushed");
    fs.appendFileSync(transcript, assistantLine(Date.now(), "msg-now", 101_000, "done") + "\n");
    hookCb!({ hook_event_name: "Stop", transcript_path: transcript, last_assistant_message: "done" });
    await vi.advanceTimersByTimeAsync(0);

    expect((await turn).contextTokens).toBe(101_000);
  });

  it("gives up on an answer that never lands, and settles on what the transcript has", async () => {
    const { transcript, turn } = await turnWithEarlierAnswer("s-never");
    hookCb!({ hook_event_name: "Stop", transcript_path: transcript, last_assistant_message: "lost" });
    await vi.advanceTimersByTimeAsync(2_500);

    const result = await turn;
    expect(result.error).toBeUndefined();
    expect(result.result).toBe("lost");
    expect(result.contextTokens).toBe(94_000);
  });
});

describe("transcriptHasTurnAnswer", () => {
  const at = Date.parse("2026-01-01T12:00:00.000Z");

  it("finds the answer written at or after the turn started, whitespace aside", () => {
    const transcript = writeTranscript([assistantLine(at, "m1", 1_000, "All five checks pass:\n\nthe branch is ready.")]);
    expect(transcriptHasTurnAnswer(transcript, at - 1, "All five checks pass: the branch is ready.")).toBe(true);
  });

  it("does not take an earlier turn's answer, or a different one, for this turn's", () => {
    const transcript = writeTranscript([assistantLine(at, "m1", 1_000, "earlier answer")]);
    expect(transcriptHasTurnAnswer(transcript, at + 1, "earlier answer")).toBe(false);
    expect(transcriptHasTurnAnswer(transcript, at - 1, "this turn's answer")).toBe(false);
  });

  it("is false for a transcript it cannot read", () => {
    expect(transcriptHasTurnAnswer("/nonexistent/t.jsonl", 0, "anything")).toBe(false);
  });
});
