import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * a gateway turn must never be settled with the answer of a turn that
 * Claude Code started on its own.
 *
 * When a background task finishes, Claude Code re-invokes the model with a
 * `<task-notification>` prompt. Nobody on the gateway asked for that turn, and
 * no run() owns it. Verified on claude 2.1.283, a prompt pasted while such a
 * re-run is in progress:
 *   - is queued behind it, and its UserPromptSubmit fires at once:
 *     UPS(<task-notification>) UPS(ours) Stop(background) Stop(ours)
 *   - or, if the re-run reaches a tool boundary first, is folded into it: one
 *     Stop for both, carrying the background turn's answer.
 * Before the fix the resolver took the first Stop it saw, so the background
 * answer was recorded as the gateway turn's reply, and a background Stop still
 * sitting in the registry buffer settled a new turn before its prompt was even
 * pasted.
 *
 * A real HookRegistry is used on purpose: its buffer replay on register() and
 * the unclaimed-Stop handoff are part of what is being tested.
 */

interface FakePty {
  pid: number;
  _exitCode: number | null;
  writes: string[];
  dataCbs: Array<(d: string) => void>;
  emit: (d: string) => void;
  onData: (cb: (d: string) => void) => { dispose(): void };
  onExit: (cb: (e: { exitCode: number }) => void) => void;
  kill: (signal?: string) => void;
  write: (d: string) => void;
  resize: (c: number, r: number) => void;
  on: (event: string, cb: (...a: any[]) => void) => void;
}

const ptys: FakePty[] = [];
/** The per-PTY SSE proxy's event sink, captured so a test can stream model output. */
const sseSinks: Array<(e: unknown) => void> = [];
vi.mock("node-pty", () => ({
  spawn: vi.fn(() => {
    const p: FakePty = {
      pid: 4000 + ptys.length,
      _exitCode: null,
      writes: [],
      dataCbs: [],
      emit(d: string) { for (const cb of p.dataCbs) cb(d); },
      onData(cb: (d: string) => void) { p.dataCbs.push(cb); return { dispose() {} }; },
      onExit() {},
      kill() {},
      write(d: string) { p.writes.push(d); },
      resize() {},
      on() {},
    };
    ptys.push(p);
    return p;
  }),
}));
vi.mock("../sse-pty-proxy.js", () => ({
  MAIN_AGENT_SENTINEL: "<!-- jinn-main-agent:5c1f -->",
  SsePtyProxy: class {
    port = 0;
    constructor(_label: string, onEvent: (e: unknown) => void) { sseSinks.push(onEvent); }
    async start() { return 41300; }
    stop() {}
  },
}));
vi.mock("../shared/claude-settings.js", () => ({
  writeSessionSettings: () => "/tmp/fake-settings.json",
}));

import { InteractiveClaudeEngine } from "../claude-interactive.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";
import { HookRegistry, type HookPayload } from "../../gateway/hook-registry.js";

const NOTIFICATION = "<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>";
const bgPrompt = (): HookPayload => ({ hook_event_name: "UserPromptSubmit", prompt: NOTIFICATION });
const prompt = (text: string): HookPayload => ({ hook_event_name: "UserPromptSubmit", prompt: text });
const stop = (text: string): HookPayload => ({ hook_event_name: "Stop", session_id: "claude-1", last_assistant_message: text });
const PASTE_START = "\x1b[200~";
const pastes = (p: FakePty) => p.writes.filter((w) => w.startsWith(PASTE_START)).length;

describe("InteractiveClaudeEngine — background re-invocations never claim a gateway turn", () => {
  let registry: HookRegistry;
  let engine: InteractiveClaudeEngine;
  let unclaimed: Array<{ id: string; text: string }>;

  beforeEach(() => {
    vi.useFakeTimers();
    ptys.length = 0;
    sseSinks.length = 0;
    registry = new HookRegistry();
    unclaimed = [];
    registry.setUnclaimedHookHandler((id, h) => unclaimed.push({ id, text: String(h.last_assistant_message ?? "") }));
    engine = new InteractiveClaudeEngine(new PtyLifecycleManager({ maxLivePtys: 4 }), registry);
  });
  afterEach(() => {
    registry.dispose();
    vi.useRealTimers();
  });

  /** A cold first turn that completes, leaving a warm PTY for the next. */
  async function warmUp(sid: string): Promise<FakePty> {
    const turn = engine.run({ sessionId: sid, prompt: "start a background task", cwd: "/tmp" } as any);
    await vi.advanceTimersByTimeAsync(20);
    registry.deliver(sid, { hook_event_name: "SessionStart", session_id: "claude-1" });
    registry.deliver(sid, prompt("start a background task"));
    registry.deliver(sid, stop("STARTED"));
    const r = await turn;
    expect(r.result).toBe("STARTED");
    expect(engine.hasWarmPty(sid)).toBe(true);
    return ptys[ptys.length - 1];
  }

  function send(sid: string, text: string) {
    let settled: any;
    const p = engine.run({ sessionId: sid, prompt: text, cwd: "/tmp" } as any).then((r) => { settled = r; return r; });
    return { p, settled: () => settled };
  }

  it("a message sent while a background re-run is in progress gets its own reply, not the re-run's", async () => {
    const sid = "s-queued";
    await warmUp(sid);
    // The background task finished; Claude Code re-invokes the model on its own.
    registry.deliver(sid, bgPrompt());
    const t = send(sid, "Reply with exactly JINNREPLY.");
    await vi.advanceTimersByTimeAsync(300);
    // Before the fix the prompt was pasted at once and queued behind the re-run
    // (UPS(ours) Stop(bg) Stop(ours), verified on 2.1.283), and the re-run's
    // Stop settled it. Now the paste waits for that Stop; a prompt submitted
    // before our paste is somebody typing, not us (see the typed-turns tests).
    registry.deliver(sid, stop("BGDONE"));
    await vi.advanceTimersByTimeAsync(1000);
    registry.deliver(sid, prompt("Reply with exactly JINNREPLY."));
    registry.deliver(sid, stop("JINNREPLY"));
    await vi.advanceTimersByTimeAsync(10);
    const r = await t.p;
    expect(r.error).toBeUndefined();
    expect(r.result).toBe("JINNREPLY");
    // The re-run's answer still reaches chat, through the external-turn sync.
    await vi.advanceTimersByTimeAsync(3000);
    expect(unclaimed.map((u) => u.text)).toContain("BGDONE");
    expect(unclaimed.map((u) => u.text)).not.toContain("JINNREPLY");
  });

  it("a re-run that starts just after the turn registered (before its prompt runs) is still not ours", async () => {
    const sid = "s-race";
    await warmUp(sid);
    const t = send(sid, "Reply with exactly JINNREPLY.");
    await vi.advanceTimersByTimeAsync(20);
    // Claude Code dequeued the notification a moment before our paste landed.
    registry.deliver(sid, bgPrompt());
    registry.deliver(sid, prompt("Reply with exactly JINNREPLY."));
    registry.deliver(sid, stop("BGDONE"));
    await vi.advanceTimersByTimeAsync(10);
    expect(t.settled()).toBeUndefined();
    registry.deliver(sid, stop("JINNREPLY"));
    const r = await t.p;
    expect(r.result).toBe("JINNREPLY");
    expect(unclaimed.map((u) => u.text)).toContain("BGDONE");
  });

  it("a background Stop still buffered when the turn registers never settles it", async () => {
    const sid = "s-buffered";
    await warmUp(sid);
    // The re-run finished moments ago; nobody has claimed its Stop yet.
    registry.deliver(sid, bgPrompt());
    registry.deliver(sid, stop("BGDONE"));
    await vi.advanceTimersByTimeAsync(500);
    const t = send(sid, "Reply with exactly JINNREPLY.");
    await vi.advanceTimersByTimeAsync(20);
    expect(t.settled()).toBeUndefined();
    registry.deliver(sid, prompt("Reply with exactly JINNREPLY."));
    registry.deliver(sid, stop("JINNREPLY"));
    const r = await t.p;
    expect(r.result).toBe("JINNREPLY");
    // Handed to the external-turn sync rather than silently dropped.
    expect(unclaimed.map((u) => u.text)).toContain("BGDONE");
  });

  it("a stale re-run prompt left in the buffer (its Stop already handed off) does not hold the turn", async () => {
    const sid = "s-stale-prompt";
    const pty = await warmUp(sid);
    registry.deliver(sid, bgPrompt());
    registry.deliver(sid, stop("BGDONE"));
    // The registry's unclaimed-Stop handoff takes the Stop and leaves the
    // prompt behind in the buffer.
    await vi.advanceTimersByTimeAsync(2500);
    expect(unclaimed.map((u) => u.text)).toEqual(["BGDONE"]);
    const before = pastes(pty);
    const t = send(sid, "Reply with exactly JINNREPLY.");
    await vi.advanceTimersByTimeAsync(20);
    expect(pastes(pty)).toBe(before + 1);
    registry.deliver(sid, prompt("Reply with exactly JINNREPLY."));
    registry.deliver(sid, stop("JINNREPLY"));
    await vi.advanceTimersByTimeAsync(20);
    expect(t.settled()?.result).toBe("JINNREPLY");
  });

  it("any turn that finished just before registering is not ours, background or not", async () => {
    // e.g. a prompt written through the terminal's stdin frame moments earlier.
    const sid = "s-stale-turn";
    await warmUp(sid);
    registry.deliver(sid, prompt("typed in the terminal"));
    registry.deliver(sid, stop("TYPED"));
    await vi.advanceTimersByTimeAsync(500);
    const t = send(sid, "Reply with exactly JINNREPLY.");
    await vi.advanceTimersByTimeAsync(20);
    expect(t.settled()).toBeUndefined();
    registry.deliver(sid, prompt("Reply with exactly JINNREPLY."));
    registry.deliver(sid, stop("JINNREPLY"));
    expect((await t.p).result).toBe("JINNREPLY");
    expect(unclaimed.map((u) => u.text)).toEqual(["TYPED"]);
  });

  describe("holding the paste until the re-run is over", () => {
    it("does not paste while a known re-run runs, then pastes once its Stop has settled", async () => {
      const sid = "s-wait";
      const pty = await warmUp(sid);
      registry.deliver(sid, bgPrompt());
      const before = pastes(pty);
      const t = send(sid, "Reply with exactly JINNREPLY.");
      await vi.advanceTimersByTimeAsync(5000);
      // Pasting now would queue the prompt behind the re-run, or fold it in.
      expect(pastes(pty)).toBe(before);
      expect(engine.isTurnRunning(sid)).toBe(true);
      registry.deliver(sid, { hook_event_name: "PreToolUse", tool_name: "Bash" });
      registry.deliver(sid, { hook_event_name: "PostToolUse", tool_name: "Bash" });
      registry.deliver(sid, stop("BGDONE"));
      await vi.advanceTimersByTimeAsync(300);
      // Claude Code may dequeue a further notification right after a Stop.
      expect(pastes(pty)).toBe(before);
      await vi.advanceTimersByTimeAsync(1000);
      expect(pastes(pty)).toBe(before + 1);
      expect(unclaimed.map((u) => u.text)).toEqual(["BGDONE"]);
      registry.deliver(sid, prompt("Reply with exactly JINNREPLY."));
      registry.deliver(sid, stop("JINNREPLY"));
      expect((await t.p).result).toBe("JINNREPLY");
    });

    it("keeps holding when a second notification starts right after the first re-run's Stop", async () => {
      const sid = "s-chain";
      const pty = await warmUp(sid);
      registry.deliver(sid, bgPrompt());
      const before = pastes(pty);
      const t = send(sid, "Reply with exactly JINNREPLY.");
      await vi.advanceTimersByTimeAsync(20);
      registry.deliver(sid, stop("BG1"));
      await vi.advanceTimersByTimeAsync(80);
      registry.deliver(sid, bgPrompt());
      await vi.advanceTimersByTimeAsync(3000);
      expect(pastes(pty)).toBe(before);
      registry.deliver(sid, stop("BG2"));
      await vi.advanceTimersByTimeAsync(1000);
      expect(pastes(pty)).toBe(before + 1);
      registry.deliver(sid, prompt("Reply with exactly JINNREPLY."));
      registry.deliver(sid, stop("JINNREPLY"));
      expect((await t.p).result).toBe("JINNREPLY");
      expect(unclaimed.map((u) => u.text)).toEqual(["BG1", "BG2"]);
    });

    it("treats notifications batched into one re-run (two prompts, one Stop) as one re-run", async () => {
      const sid = "s-batched";
      const pty = await warmUp(sid);
      registry.deliver(sid, bgPrompt());
      registry.deliver(sid, bgPrompt());
      const before = pastes(pty);
      const t = send(sid, "Reply with exactly JINNREPLY.");
      await vi.advanceTimersByTimeAsync(20);
      registry.deliver(sid, stop("BGSEEN"));
      await vi.advanceTimersByTimeAsync(1000);
      expect(pastes(pty)).toBe(before + 1);
      registry.deliver(sid, prompt("Reply with exactly JINNREPLY."));
      registry.deliver(sid, stop("JINNREPLY"));
      expect((await t.p).result).toBe("JINNREPLY");
    });

    it("gives up on a re-run whose Stop never came once Claude Code has gone quiet", async () => {
      const sid = "s-lost-stop";
      const pty = await warmUp(sid);
      registry.deliver(sid, bgPrompt());
      const before = pastes(pty);
      const t = send(sid, "Reply with exactly JINNREPLY.");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(pastes(pty)).toBe(before);
      await vi.advanceTimersByTimeAsync(6000);
      expect(pastes(pty)).toBe(before + 1);
      registry.deliver(sid, prompt("Reply with exactly JINNREPLY."));
      registry.deliver(sid, stop("JINNREPLY"));
      expect((await t.p).result).toBe("JINNREPLY");
    });

    it("keeps holding while the re-run is visibly working, even past the quiet window", async () => {
      const sid = "s-busy";
      const pty = await warmUp(sid);
      registry.deliver(sid, bgPrompt());
      const before = pastes(pty);
      const t = send(sid, "Reply with exactly JINNREPLY.");
      // A long tool in the re-run: PreToolUse with no PostToolUse yet.
      registry.deliver(sid, { hook_event_name: "PreToolUse", tool_name: "Bash" });
      for (let i = 0; i < 12; i += 1) {
        await vi.advanceTimersByTimeAsync(5000);
        pty.emit("\x1b[2K spinner"); // the TUI redraws while it works
      }
      expect(pastes(pty)).toBe(before);
      registry.deliver(sid, { hook_event_name: "PostToolUse", tool_name: "Bash" });
      registry.deliver(sid, stop("BGDONE"));
      await vi.advanceTimersByTimeAsync(1000);
      expect(pastes(pty)).toBe(before + 1);
      registry.deliver(sid, prompt("Reply with exactly JINNREPLY."));
      registry.deliver(sid, stop("JINNREPLY"));
      expect((await t.p).result).toBe("JINNREPLY");
    });

    it("an interrupt while waiting ends the turn without ever pasting", async () => {
      const sid = "s-interrupt";
      const pty = await warmUp(sid);
      registry.deliver(sid, bgPrompt());
      const before = pastes(pty);
      const t = send(sid, "Reply with exactly JINNREPLY.");
      await vi.advanceTimersByTimeAsync(1000);
      engine.kill(sid, "Interrupted: stopped by user");
      const r = await t.p;
      expect(r.error).toMatch(/^Interrupted/);
      await vi.advanceTimersByTimeAsync(2000);
      expect(pastes(pty)).toBe(before);
    });

    it("a native command waits too, and does not swallow the re-run's Stop", async () => {
      const sid = "s-native";
      const pty = await warmUp(sid);
      registry.deliver(sid, bgPrompt());
      const before = pastes(pty);
      const t = send(sid, "/compact");
      await vi.advanceTimersByTimeAsync(4000);
      expect(pastes(pty)).toBe(before);
      registry.deliver(sid, stop("BGDONE"));
      await vi.advanceTimersByTimeAsync(1000);
      expect(pastes(pty)).toBe(before + 1);
      expect(unclaimed.map((u) => u.text)).toEqual(["BGDONE"]);
      await vi.advanceTimersByTimeAsync(5000);
      const r = await t.p;
      expect(r.error).toBeUndefined();
      expect(r.result).toBe("");
    });

    it("a re-run that starts after the turn settled makes the next turn wait", async () => {
      const sid = "s-after";
      const pty = await warmUp(sid);
      const t2 = send(sid, "second");
      await vi.advanceTimersByTimeAsync(20);
      registry.deliver(sid, prompt("second"));
      registry.deliver(sid, stop("SECOND"));
      expect((await t2.p).result).toBe("SECOND");
      // The notification that completed during turn 2 is dequeued after its Stop.
      registry.deliver(sid, bgPrompt());
      const before = pastes(pty);
      const t3 = send(sid, "third");
      await vi.advanceTimersByTimeAsync(3000);
      expect(pastes(pty)).toBe(before);
      registry.deliver(sid, stop("BGDONE"));
      await vi.advanceTimersByTimeAsync(1000);
      expect(pastes(pty)).toBe(before + 1);
      registry.deliver(sid, prompt("third"));
      registry.deliver(sid, stop("THIRD"));
      expect((await t3.p).result).toBe("THIRD");
    });
  });

  describe("a re-run that hits an API error (QA round 1)", () => {
    const failure = (error: string): HookPayload => ({ hook_event_name: "StopFailure", error, session_id: "claude-1" });

    it("a retryable StopFailure does not end the re-run: the retry's Stop is still not ours", async () => {
      const sid = "s-retry";
      const pty = await warmUp(sid);
      registry.deliver(sid, bgPrompt());
      const before = pastes(pty);
      const t = send(sid, "Reply with exactly JINNREPLY.");
      await vi.advanceTimersByTimeAsync(300);
      registry.deliver(sid, failure("server_error"));
      pty.emit("retrying"); // the CLI keeps working
      await vi.advanceTimersByTimeAsync(3000);
      expect(pastes(pty)).toBe(before);
      registry.deliver(sid, stop("BGDONE")); // the retried re-run finishes
      await vi.advanceTimersByTimeAsync(1000);
      expect(pastes(pty)).toBe(before + 1);
      registry.deliver(sid, prompt("Reply with exactly JINNREPLY."));
      registry.deliver(sid, stop("JINNREPLY"));
      expect((await t.p).result).toBe("JINNREPLY");
      expect(unclaimed.map((u) => u.text)).toEqual(["BGDONE"]);
    });

    it("the same holds for a retryable StopFailure seen while no turn owned the session", async () => {
      const sid = "s-retry-idle";
      const pty = await warmUp(sid);
      registry.deliver(sid, bgPrompt());
      registry.deliver(sid, failure("unknown"));
      const before = pastes(pty);
      const t = send(sid, "Reply with exactly JINNREPLY.");
      await vi.advanceTimersByTimeAsync(3000);
      expect(pastes(pty)).toBe(before);
      registry.deliver(sid, stop("BGDONE"));
      await vi.advanceTimersByTimeAsync(1000);
      expect(pastes(pty)).toBe(before + 1);
      registry.deliver(sid, prompt("Reply with exactly JINNREPLY."));
      registry.deliver(sid, stop("JINNREPLY"));
      expect((await t.p).result).toBe("JINNREPLY");
    });

    it("a retryable StopFailure the CLI does not retry is released by the quiet backstop", async () => {
      const sid = "s-retry-given-up";
      const pty = await warmUp(sid);
      registry.deliver(sid, bgPrompt());
      const before = pastes(pty);
      const t = send(sid, "Reply with exactly JINNREPLY.");
      await vi.advanceTimersByTimeAsync(300);
      registry.deliver(sid, failure("server_error"));
      await vi.advanceTimersByTimeAsync(16_000);
      expect(pastes(pty)).toBe(before + 1);
      registry.deliver(sid, prompt("Reply with exactly JINNREPLY."));
      registry.deliver(sid, stop("JINNREPLY"));
      expect((await t.p).result).toBe("JINNREPLY");
    });

    it("a StopFailure the CLI does not survive ends the re-run at once", async () => {
      const sid = "s-rate-limited";
      const pty = await warmUp(sid);
      registry.deliver(sid, bgPrompt());
      const before = pastes(pty);
      const t = send(sid, "Reply with exactly JINNREPLY.");
      await vi.advanceTimersByTimeAsync(300);
      registry.deliver(sid, failure("rate_limit"));
      await vi.advanceTimersByTimeAsync(1000);
      expect(pastes(pty)).toBe(before + 1);
      registry.deliver(sid, prompt("Reply with exactly JINNREPLY."));
      registry.deliver(sid, stop("JINNREPLY"));
      expect((await t.p).result).toBe("JINNREPLY");
    });
  });

  describe("background subagents' tool hooks (QA round 1)", () => {
    const subagentTool = (event: string): HookPayload => ({ hook_event_name: event, tool_name: "Read", tool_use_id: "sub-1", agent_id: "a1" });

    it("are not taken for our queued prompt being folded into the re-run", async () => {
      const sid = "s-subagent-fold";
      await warmUp(sid);
      const t = send(sid, "Reply with exactly JINNREPLY.");
      await vi.advanceTimersByTimeAsync(20);
      registry.deliver(sid, bgPrompt());
      registry.deliver(sid, prompt("Reply with exactly JINNREPLY."));
      registry.deliver(sid, subagentTool("PreToolUse"));
      registry.deliver(sid, subagentTool("PostToolUse"));
      registry.deliver(sid, stop("BGDONE"));
      await vi.advanceTimersByTimeAsync(10);
      expect(t.settled()).toBeUndefined();
      registry.deliver(sid, stop("JINNREPLY"));
      expect((await t.p).result).toBe("JINNREPLY");
    });

    it("are not taken for our queued prompt having started running", async () => {
      const sid = "s-subagent-running";
      await warmUp(sid);
      const t = send(sid, "Reply with exactly JINNREPLY.");
      await vi.advanceTimersByTimeAsync(20);
      registry.deliver(sid, bgPrompt());
      registry.deliver(sid, prompt("Reply with exactly JINNREPLY."));
      registry.deliver(sid, stop("BG1"));
      registry.deliver(sid, subagentTool("PostToolUse"));
      registry.deliver(sid, bgPrompt());
      registry.deliver(sid, stop("BG2"));
      await vi.advanceTimersByTimeAsync(10);
      expect(t.settled()).toBeUndefined();
      registry.deliver(sid, stop("JINNREPLY"));
      expect((await t.p).result).toBe("JINNREPLY");
    });
  });

  it("a turn held behind a re-run does not report its prompt as unaccepted (QA round 1)", async () => {
    const sid = "s-progress";
    await warmUp(sid);
    registry.deliver(sid, bgPrompt());
    const t = send(sid, "Reply with exactly JINNREPLY.");
    await vi.advanceTimersByTimeAsync(3000);
    expect(engine.turnProgress(sid)?.awaitingSubmit).toBe(false);
    registry.deliver(sid, stop("BGDONE"));
    await vi.advanceTimersByTimeAsync(1000);
    // Pasted now, and not yet acknowledged.
    expect(engine.turnProgress(sid)?.awaitingSubmit).toBe(true);
    registry.deliver(sid, prompt("Reply with exactly JINNREPLY."));
    registry.deliver(sid, stop("JINNREPLY"));
    expect((await t.p).result).toBe("JINNREPLY");
  });

  describe("attribution once the prompt is pasted", () => {
    it("a notification folded into our own running turn does not make its Stop foreign", async () => {
      // Verified on 2.1.283: a task that finishes during a foreground tool is
      // folded in at the tool boundary — `PostToolUse UPS(bg) Stop`.
      const sid = "s-folded-into-ours";
      await warmUp(sid);
      const t = send(sid, "run a tool");
      await vi.advanceTimersByTimeAsync(20);
      registry.deliver(sid, prompt("run a tool"));
      registry.deliver(sid, { hook_event_name: "PreToolUse", tool_name: "Bash" });
      registry.deliver(sid, { hook_event_name: "PostToolUse", tool_name: "Bash" });
      registry.deliver(sid, bgPrompt());
      registry.deliver(sid, stop("TURNDONE\n\nBGSEEN"));
      const r = await t.p;
      expect(r.result).toBe("TURNDONE\n\nBGSEEN");
      expect(unclaimed).toEqual([]);
    });

    it("a prompt folded into a re-run ahead of it settles on the one Stop instead of hanging", async () => {
      // The race path: the re-run began just as we pasted, and reached a tool
      // boundary with our prompt queued — `UPS(bg) UPS(ours) Pre Post Stop`.
      const sid = "s-folded-into-rerun";
      await warmUp(sid);
      const t = send(sid, "Reply with exactly JINNREPLY.");
      await vi.advanceTimersByTimeAsync(20);
      registry.deliver(sid, bgPrompt());
      registry.deliver(sid, prompt("Reply with exactly JINNREPLY."));
      registry.deliver(sid, { hook_event_name: "PreToolUse", tool_name: "Bash" });
      registry.deliver(sid, { hook_event_name: "PostToolUse", tool_name: "Bash" });
      registry.deliver(sid, stop("BGDONE"));
      const r = await t.p;
      // One Stop for both: the prompt was folded, so this is its only reply.
      expect(r.result).toBe("BGDONE");
      expect(unclaimed).toEqual([]);
    });

    it("a second re-run dequeued ahead of our queued prompt is foreign too", async () => {
      const sid = "s-two-ahead";
      await warmUp(sid);
      const t = send(sid, "Reply with exactly JINNREPLY.");
      await vi.advanceTimersByTimeAsync(20);
      registry.deliver(sid, bgPrompt());
      registry.deliver(sid, prompt("Reply with exactly JINNREPLY."));
      registry.deliver(sid, stop("BG1"));
      registry.deliver(sid, bgPrompt());
      registry.deliver(sid, stop("BG2"));
      await vi.advanceTimersByTimeAsync(10);
      expect(t.settled()).toBeUndefined();
      registry.deliver(sid, stop("JINNREPLY"));
      expect((await t.p).result).toBe("JINNREPLY");
      expect(unclaimed.map((u) => u.text)).toEqual(["BG1", "BG2"]);
    });

    it("the re-run's hooks neither acknowledge our paste nor stream into our turn", async () => {
      const sid = "s-gated";
      const pty = await warmUp(sid);
      const deltas: unknown[] = [];
      const turn = engine.run({ sessionId: sid, prompt: "mine", cwd: "/tmp", onStream: (d: unknown) => deltas.push(d) } as any);
      await vi.advanceTimersByTimeAsync(20);
      registry.deliver(sid, bgPrompt());
      registry.deliver(sid, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "tu-bg" });
      registry.deliver(sid, {
        hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "tu-bg",
        tool_input: { command: "sleep 6" }, tool_response: { stdout: "bg output" },
      });
      expect(deltas).toEqual([]);
      expect(engine.turnProgress(sid)?.awaitingSubmit).toBe(true);
      // Our prompt is still unacknowledged, so the CR retries keep going.
      const crsBefore = pty.writes.filter((w) => w === "\r").length;
      await vi.advanceTimersByTimeAsync(3500);
      expect(pty.writes.filter((w) => w === "\r").length).toBeGreaterThan(crsBefore);
      registry.deliver(sid, stop("BGDONE"));
      registry.deliver(sid, prompt("mine"));
      expect(engine.turnProgress(sid)?.awaitingSubmit).toBe(false);
      registry.deliver(sid, stop("MINE"));
      expect((await turn).result).toBe("MINE");
    });

    it("the re-run's model output does not stream into our turn; ours does", async () => {
      const sid = "s-sse";
      await warmUp(sid);
      const sse = sseSinks[sseSinks.length - 1];
      const text = (t: string) => ({ type: "content_block_delta", delta: { type: "text_delta", text: t } });
      const deltas: Array<{ type: string; content: string }> = [];
      const turn = engine.run({ sessionId: sid, prompt: "mine", cwd: "/tmp", onStream: (d: any) => deltas.push(d) } as any);
      await vi.advanceTimersByTimeAsync(20);
      registry.deliver(sid, bgPrompt());
      registry.deliver(sid, prompt("mine"));
      sse({ type: "message_start" });
      sse(text("1 2 3 BGDONE"));
      sse({ type: "message_stop" });
      registry.deliver(sid, stop("BGDONE"));
      sse({ type: "message_start" });
      sse(text("MINE"));
      sse({ type: "message_stop" });
      registry.deliver(sid, stop("MINE"));
      expect((await turn).result).toBe("MINE");
      expect(deltas.filter((d) => d.type === "text").map((d) => d.content).join("")).toBe("MINE");
    });
  });

  it("ordinary warm turns are unchanged: the first Stop after our prompt settles them", async () => {
    const sid = "s-plain";
    const pty = await warmUp(sid);
    const before = pastes(pty);
    const t = send(sid, "plain");
    await vi.advanceTimersByTimeAsync(20);
    expect(pastes(pty)).toBe(before + 1); // no wait without a re-run
    registry.deliver(sid, prompt("plain"));
    registry.deliver(sid, stop("PLAIN"));
    expect((await t.p).result).toBe("PLAIN");
    expect(unclaimed).toEqual([]);
  });
});
