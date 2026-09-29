import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * the web terminal is interactive, so the operator can type turns
 * straight into a claude PTY that also runs gateway turns.
 *
 * Verified on claude 2.1.283: a prompt pasted while a turn runs is queued, and
 * its UserPromptSubmit fires AT ONCE, not when it runs; at a tool boundary it is
 * folded into the running turn instead (one Stop for two prompts). So once a
 * gateway prompt is pasted behind a terminal turn, no hook says which Stop is
 * whose. The engine therefore holds a gateway turn until a terminal turn has
 * finished, and a warm-PTY gateway turn only settles on a Stop that follows its
 * own live UserPromptSubmit (never a Stop replayed from the registry buffer).
 *
 * A real HookRegistry is used on purpose: its tap, buffer replay on register()
 * and the unclaimed-Stop handoff are all part of what is being tested.
 */

interface FakePty {
  pid: number;
  _exitCode: number | null;
  writes: string[];
  dataCbs: Array<(d: string) => void>;
  emit: (d: string) => void;
  onData: (cb: (d: string) => void) => void;
  onExit: (cb: (e: { exitCode: number }) => void) => void;
  kill: (signal?: string) => void;
  write: (d: string) => void;
  resize: (c: number, r: number) => void;
  on: (event: string, cb: (...a: any[]) => void) => void;
}

const ptys: FakePty[] = [];
vi.mock("node-pty", () => ({
  spawn: vi.fn(() => {
    const p: FakePty = {
      pid: 3000 + ptys.length,
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
    constructor(_label: string, _onEvent: (e: unknown) => void) {}
    async start() { return 41200; }
    stop() {}
  },
}));
vi.mock("../shared/claude-settings.js", () => ({
  writeSessionSettings: () => "/tmp/fake-settings.json",
}));

import {
  InteractiveClaudeEngine,
  recoveryFloorMs,
  TERMINAL_TURN_QUIET_MS,
  viewportShowsLiveSafetyPrompt,
} from "../claude-interactive.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";
import { HookRegistry } from "../../gateway/hook-registry.js";

/** Claude Code's safety dialog as drawn (same frame the permission-prompt tests use). */
const SAFETY_PROMPT_FRAME = [
  "",
  " Bash command",
  "",
  '   rm -rf "$W4/$d"',
  "",
  ' Dangerous rm operation on possibly-empty variable path: "$W4/$d"',
  "",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. No",
  "",
  " Esc to cancel · Tab to amend · ctrl+e to explain",
].join("\r\n");

describe("InteractiveClaudeEngine — turns typed into the terminal (G1)", => {
  let registry: HookRegistry;
  let engine: InteractiveClaudeEngine;
  let unclaimed: Array<{ id: string; text: string }>;
  /** Per unclaimed delivery: did the running gateway turn disown it? */
  let handoffs: boolean[];

  beforeEach(() => {
    vi.useFakeTimers();
    ptys.length = 0;
    unclaimed = [];
    // 30s buffer TTL, 5s sweep, 2s unclaimed claim window — the production defaults.
    registry = new HookRegistry(30_000, 5_000, 2_000);
    handoffs = [];
    registry.setUnclaimedHookHandler((id, h, context) => {
      unclaimed.push({ id, text: String(h.last_assistant_message ?? "") });
      handoffs.push(context?.foreignToRunningTurn === true);
    });
    engine = new InteractiveClaudeEngine(new PtyLifecycleManager({ maxLivePtys: 10 }), registry);
  });

  afterEach(() => {
    registry.dispose?.();
    vi.useRealTimers();
  });

  const deliver = (id: string, h: Record<string, unknown>) => registry.deliver(id, h as any);

  /** Turn 1 cold-spawns and completes, leaving the PTY warm for the gateway's
   *  paste-and-submit path — the only path the gate applies to. */
  async function warmUp(id: string): Promise<void> {
    const turn = engine.run({ sessionId: id, prompt: "first", cwd: "/tmp" } as any);
    await vi.advanceTimersByTimeAsync(20);
    deliver(id, { hook_event_name: "SessionStart", session_id: "c1" });
    deliver(id, { hook_event_name: "Stop", last_assistant_message: "first answer" });
    const r = await turn;
    expect(r.result).toBe("first answer");
    expect(engine.hasWarmPty(id)).toBe(true);
  }

  async function settledWithin<T>(p: Promise<T>, ms: number): Promise<{ settled: boolean; value?: T }> {
    let value: T | undefined;
    let settled = false;
    void p.then((v) => { value = v; settled = true; });
    await vi.advanceTimersByTimeAsync(ms);
    return { settled, value };
  }

  it("cold spawn: a bare Stop settles the turn exactly as before", async () => {
    const turn = engine.run({ sessionId: "s-cold", prompt: "only", cwd: "/tmp" } as any);
    await vi.advanceTimersByTimeAsync(20);
    deliver("s-cold", { hook_event_name: "SessionStart", session_id: "c1" });
    deliver("s-cold", { hook_event_name: "Stop", last_assistant_message: "cold answer" });
    expect((await turn).result).toBe("cold answer");
    expect(unclaimed).toEqual([]);
  });

  it("warm: the gateway turn settles on its own Stop after its own UserPromptSubmit", async () => {
    await warmUp("s-warm");
    const turn = engine.run({ sessionId: "s-warm", prompt: "second", cwd: "/tmp", resumeSessionId: "c1" } as any);
    await vi.advanceTimersByTimeAsync(200);
    deliver("s-warm", { hook_event_name: "UserPromptSubmit", prompt: "second" });
    deliver("s-warm", { hook_event_name: "Stop", last_assistant_message: "second answer" });
    expect((await turn).result).toBe("second answer");
    expect(unclaimed).toEqual([]);
  });

  it("warm native command: settles without a UserPromptSubmit, as before", async () => {
    await warmUp("s-native");
    const turn = engine.run({ sessionId: "s-native", prompt: "/usage", cwd: "/tmp", resumeSessionId: "c1" } as any);
    await vi.advanceTimersByTimeAsync(200);
    // /usage fires a Stop carrying the PREVIOUS turn's text and no UPS.
    deliver("s-native", { hook_event_name: "Stop", last_assistant_message: "first answer" });
    const r = await turn;
    expect(r.error).toBeUndefined();
    expect(r.result).toBe("");
  });

  const pasted = (text: string) => ptys[0]!.writes.some((w) => w.includes(text));

  it("gateway turn arriving mid-operator-turn: waits for it, then runs as its own turn; the operator's reaches the sync", async () => {
    await warmUp("s-mid");
    // Operator types a prompt in the terminal; no gateway turn owns the session.
    deliver("s-mid", { hook_event_name: "UserPromptSubmit", prompt: "operator question" });
    deliver("s-mid", { hook_event_name: "PreToolUse", tool_name: "Bash" });

    // A composer message arrives while that turn runs. It must NOT be pasted
    // behind it: Claude Code would fire its UPS at once and the operator's Stop
    // would be indistinguishable from ours.
    const turn = engine.run({ sessionId: "s-mid", prompt: "composer message", cwd: "/tmp", resumeSessionId: "c1" } as any);
    // Keep the TUI visibly busy (spinner redraws) past the quiet window.
    for (let i = 0; i < 8; i++) { ptys[0]!.emit("✻"); await vi.advanceTimersByTimeAsync(1_000); }
    expect(pasted("composer message")).toBe(false);

    // The operator's turn finishes; its Stop is unclaimed.
    deliver("s-mid", { hook_event_name: "PostToolUse", tool_name: "Bash" });
    deliver("s-mid", { hook_event_name: "Stop", last_assistant_message: "operator answer" });
    await vi.advanceTimersByTimeAsync(500);
    expect(pasted("composer message")).toBe(true);
    // The operator's Stop reached the external sync (replayed into our listener
    // inside the claim window, recognised as foreign, handed over) — once.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(unclaimed).toEqual([{ id: "s-mid", text: "operator answer" }]);
    // Handed over by the running turn, so the sync must not skip it as "running".
    expect(handoffs).toEqual([true]);

    deliver("s-mid", { hook_event_name: "UserPromptSubmit", prompt: "composer message" });
    deliver("s-mid", { hook_event_name: "Stop", last_assistant_message: "composer answer" });
    expect((await turn).result).toBe("composer answer");
    expect(unclaimed).toHaveLength(1);
  });

  it("a terminal turn folded shut without a Stop (merged at a tool boundary) is released by TUI silence", async () => {
    await warmUp("s-quiet");
    deliver("s-quiet", { hook_event_name: "UserPromptSubmit", prompt: "operator question" });
    const turn = engine.run({ sessionId: "s-quiet", prompt: "composer message", cwd: "/tmp", resumeSessionId: "c1" } as any);
    ptys[0]!.emit("✻");
    await vi.advanceTimersByTimeAsync(TERMINAL_TURN_QUIET_MS - 500);
    expect(pasted("composer message")).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pasted("composer message")).toBe(true);
    deliver("s-quiet", { hook_event_name: "UserPromptSubmit", prompt: "composer message" });
    deliver("s-quiet", { hook_event_name: "Stop", last_assistant_message: "composer answer" });
    expect((await turn).result).toBe("composer answer");
  });

  it("refuses a second gateway turn while one is waiting behind a terminal turn", async () => {
    await warmUp("s-dup");
    deliver("s-dup", { hook_event_name: "UserPromptSubmit", prompt: "operator question" });
    void engine.run({ sessionId: "s-dup", prompt: "one", cwd: "/tmp", resumeSessionId: "c1" } as any);
    await vi.advanceTimersByTimeAsync(10);
    const second = await engine.run({ sessionId: "s-dup", prompt: "two", cwd: "/tmp", resumeSessionId: "c1" } as any);
    expect(second.error).toMatch(/already running/);
    engine.kill("s-dup");
  });

  it("operator turn that finished just before the gateway turn registered: its buffered Stop is not replayed as ours", async () => {
    await warmUp("s-just");
    deliver("s-just", { hook_event_name: "UserPromptSubmit", prompt: "operator question" });
    deliver("s-just", { hook_event_name: "Stop", last_assistant_message: "operator answer" });
    // Inside the 2s unclaimed window: register() claims and replays the buffer.
    await vi.advanceTimersByTimeAsync(500);
    const turn = engine.run({ sessionId: "s-just", prompt: "composer message", cwd: "/tmp", resumeSessionId: "c1" } as any);
    await vi.advanceTimersByTimeAsync(200);
    expect(pasted("composer message")).toBe(true); // nothing to wait for

    const early = await settledWithin(turn, 1_000);
    expect(early.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(unclaimed).toEqual([{ id: "s-just", text: "operator answer" }]);

    deliver("s-just", { hook_event_name: "UserPromptSubmit", prompt: "composer message" });
    deliver("s-just", { hook_event_name: "Stop", last_assistant_message: "composer answer" });
    expect((await turn).result).toBe("composer answer");
  });

  it("operator prompt typed mid-gateway-turn: the gateway turn keeps its answer, and the NEXT gateway turn waits for the operator's", async () => {
    await warmUp("s-queued");
    const turn = engine.run({ sessionId: "s-queued", prompt: "composer message", cwd: "/tmp", resumeSessionId: "c1" } as any);
    await vi.advanceTimersByTimeAsync(200);
    deliver("s-queued", { hook_event_name: "UserPromptSubmit", prompt: "composer message" });
    // Operator types and presses Enter while ours runs: queued, UPS at once.
    deliver("s-queued", { hook_event_name: "UserPromptSubmit", prompt: "operator question" });
    deliver("s-queued", { hook_event_name: "Stop", last_assistant_message: "composer answer" });
    expect((await turn).result).toBe("composer answer");

    // The queued operator turn is now running. A new composer message waits.
    const next = engine.run({ sessionId: "s-queued", prompt: "next message", cwd: "/tmp", resumeSessionId: "c1" } as any);
    ptys[0]!.emit("✻");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pasted("next message")).toBe(false);
    deliver("s-queued", { hook_event_name: "Stop", last_assistant_message: "operator answer" });
    await vi.advanceTimersByTimeAsync(500);
    expect(pasted("next message")).toBe(true);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(unclaimed).toEqual([{ id: "s-queued", text: "operator answer" }]);
    deliver("s-queued", { hook_event_name: "UserPromptSubmit", prompt: "next message" });
    deliver("s-queued", { hook_event_name: "Stop", last_assistant_message: "next answer" });
    expect((await next).result).toBe("next answer");
  });

  it("a StopFailure ending the operator's turn releases the wait and does not fail the gateway turn", async () => {
    await warmUp("s-fail");
    deliver("s-fail", { hook_event_name: "UserPromptSubmit", prompt: "operator question" });
    const turn = engine.run({ sessionId: "s-fail", prompt: "composer message", cwd: "/tmp", resumeSessionId: "c1" } as any);
    ptys[0]!.emit("✻");
    await vi.advanceTimersByTimeAsync(1_000);
    deliver("s-fail", { hook_event_name: "StopFailure", error: "server_error" });
    await vi.advanceTimersByTimeAsync(500);
    expect(pasted("composer message")).toBe(true);
    const early = await settledWithin(turn, 1_000);
    expect(early.settled).toBe(false);

    deliver("s-fail", { hook_event_name: "UserPromptSubmit", prompt: "composer message" });
    deliver("s-fail", { hook_event_name: "Stop", last_assistant_message: "composer answer" });
    expect((await turn).result).toBe("composer answer");
  });

  it("no terminal typing, no waiting: an ordinary warm turn pastes immediately", async () => {
    await warmUp("s-plain");
    void engine.run({ sessionId: "s-plain", prompt: "composer message", cwd: "/tmp", resumeSessionId: "c1" } as any);
    await vi.advanceTimersByTimeAsync(20);
    expect(pasted("composer message")).toBe(true);
    engine.kill("s-plain");
  });

  // ── Found by senior-developer-qa (round 1) ─────────────────────

  it("QA-A: a prompt typed during a COLD gateway turn makes the next gateway turn wait for it", async () => {
    const turn1 = engine.run({ sessionId: "s-qa-a", prompt: "first", cwd: "/tmp" } as any);
    await vi.advanceTimersByTimeAsync(20);
    deliver("s-qa-a", { hook_event_name: "SessionStart", session_id: "c1" });
    deliver("s-qa-a", { hook_event_name: "UserPromptSubmit", prompt: "first" }); // argv prompts fire UPS too
    deliver("s-qa-a", { hook_event_name: "UserPromptSubmit", prompt: "operator question" }); // typed mid-turn: queued
    deliver("s-qa-a", { hook_event_name: "Stop", last_assistant_message: "first answer" });
    expect((await turn1).result).toBe("first answer");

    const turn2 = engine.run({ sessionId: "s-qa-a", prompt: "composer message", cwd: "/tmp", resumeSessionId: "c1" } as any);
    ptys[0]!.emit("✻");
    await vi.advanceTimersByTimeAsync(300);
    expect(pasted("composer message")).toBe(false);
    deliver("s-qa-a", { hook_event_name: "Stop", last_assistant_message: "operator answer" });
    await vi.advanceTimersByTimeAsync(500);
    expect(pasted("composer message")).toBe(true);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(unclaimed).toEqual([{ id: "s-qa-a", text: "operator answer" }]);
    deliver("s-qa-a", { hook_event_name: "UserPromptSubmit", prompt: "composer message" });
    deliver("s-qa-a", { hook_event_name: "Stop", last_assistant_message: "composer answer" });
    expect((await turn2).result).toBe("composer answer");
  });

  it("QA-A: a prompt typed during a native command counts as queued (natives fire no UPS of their own)", async () => {
    await warmUp("s-qa-native");
    const native = engine.run({ sessionId: "s-qa-native", prompt: "/compact", cwd: "/tmp", resumeSessionId: "c1" } as any);
    await vi.advanceTimersByTimeAsync(200);
    deliver("s-qa-native", { hook_event_name: "UserPromptSubmit", prompt: "operator question" });
    // The native command settles on its own quiet window.
    await vi.advanceTimersByTimeAsync(4_000);
    expect((await native).error).toBeUndefined();

    const next = engine.run({ sessionId: "s-qa-native", prompt: "composer message", cwd: "/tmp", resumeSessionId: "c1" } as any);
    ptys[0]!.emit("✻");
    await vi.advanceTimersByTimeAsync(300);
    expect(pasted("composer message")).toBe(false);
    deliver("s-qa-native", { hook_event_name: "Stop", last_assistant_message: "operator answer" });
    await vi.advanceTimersByTimeAsync(500);
    expect(pasted("composer message")).toBe(true);
    deliver("s-qa-native", { hook_event_name: "UserPromptSubmit", prompt: "composer message" });
    deliver("s-qa-native", { hook_event_name: "Stop", last_assistant_message: "composer answer" });
    expect((await next).result).toBe("composer answer");
  });

  it("QA-B: a turn typed after a failed gateway turn is not taken as its late recovery; it reaches the sync", async () => {
    await warmUp("s-qa-b");
    const late: string[] = [];
    const turn = engine.run({
      sessionId: "s-qa-b", prompt: "second", cwd: "/tmp", resumeSessionId: "c1",
      onLateRecovery: ({ result }: { result: string }) => late.push(result),
    } as any);
    await vi.advanceTimersByTimeAsync(200);
    deliver("s-qa-b", { hook_event_name: "UserPromptSubmit", prompt: "second" });
    deliver("s-qa-b", { hook_event_name: "StopFailure", error: "rate_limit" });
    expect((await turn).error).toBeTruthy();
    await vi.advanceTimersByTimeAsync(60_000);
    deliver("s-qa-b", { hook_event_name: "UserPromptSubmit", prompt: "operator question" });
    deliver("s-qa-b", { hook_event_name: "Stop", last_assistant_message: "operator answer" });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(late).toEqual([]);
    expect(unclaimed).toEqual([{ id: "s-qa-b", text: "operator answer" }]);
  });

  it("QA-B control: the failed turn's own late Stop (no new prompt) is still recovered", async () => {
    await warmUp("s-qa-b2");
    const late: string[] = [];
    const turn = engine.run({
      sessionId: "s-qa-b2", prompt: "second", cwd: "/tmp", resumeSessionId: "c1",
      onLateRecovery: ({ result }: { result: string }) => late.push(result),
    } as any);
    await vi.advanceTimersByTimeAsync(200);
    deliver("s-qa-b2", { hook_event_name: "UserPromptSubmit", prompt: "second" });
    deliver("s-qa-b2", { hook_event_name: "StopFailure", error: "rate_limit" });
    await turn;
    deliver("s-qa-b2", { hook_event_name: "Stop", last_assistant_message: "second answer, late" });
    expect(late).toEqual(["second answer, late"]);
  });

  it("QA-C: a terminal turn visibly working past 20 minutes still holds the gateway turn; nothing is pasted behind it", async () => {
    await warmUp("s-qa-c");
    deliver("s-qa-c", { hook_event_name: "UserPromptSubmit", prompt: "operator question" });
    const turn = engine.run({ sessionId: "s-qa-c", prompt: "composer message", cwd: "/tmp", resumeSessionId: "c1" } as any);
    for (let i = 0; i < 25 * 20; i++) { ptys[0]!.emit("✻"); await vi.advanceTimersByTimeAsync(3_000); }
    expect(pasted("composer message")).toBe(false);
    deliver("s-qa-c", { hook_event_name: "Stop", last_assistant_message: "operator answer" });
    await vi.advanceTimersByTimeAsync(500);
    expect(pasted("composer message")).toBe(true);
    deliver("s-qa-c", { hook_event_name: "UserPromptSubmit", prompt: "composer message" });
    deliver("s-qa-c", { hook_event_name: "Stop", last_assistant_message: "composer answer" });
    expect((await turn).result).toBe("composer answer");
  });

  it("COO decision: no time limit — a gateway turn waits as long as the terminal turn runs, and is visibly waiting", async () => {
    const waits: Array<[string, boolean]> = [];
    engine.onTerminalWait((id, waiting) => waits.push([id, waiting]));
    await warmUp("s-visible");
    deliver("s-visible", { hook_event_name: "UserPromptSubmit", prompt: "operator question" });
    const turn = engine.run({ sessionId: "s-visible", prompt: "composer message", cwd: "/tmp", resumeSessionId: "c1" } as any);
    await vi.advanceTimersByTimeAsync(10);
    expect(waits).toEqual([["s-visible", true]]);
    const progress = engine.turnProgress("s-visible");
    expect(progress?.waitingForTerminalTurn).toBe(true);
    expect(progress?.awaitingSubmit).toBe(false);
    // Two hours of a visibly busy terminal: still waiting, nothing pasted, no error.
    for (let i = 0; i < (2 * 60 * 60_000) / 3_000; i++) { ptys[0]!.emit("✻"); await vi.advanceTimersByTimeAsync(3_000); }
    expect(pasted("composer message")).toBe(false);
    expect(engine.turnProgress("s-visible")?.waitingForTerminalTurn).toBe(true);
    deliver("s-visible", { hook_event_name: "Stop", last_assistant_message: "operator answer" });
    await vi.advanceTimersByTimeAsync(500);
    expect(waits).toEqual([["s-visible", true], ["s-visible", false]]);
    expect(pasted("composer message")).toBe(true);
    expect(engine.turnProgress("s-visible")?.waitingForTerminalTurn).toBeUndefined();
    deliver("s-visible", { hook_event_name: "UserPromptSubmit", prompt: "composer message" });
    deliver("s-visible", { hook_event_name: "Stop", last_assistant_message: "composer answer" });
    expect((await turn).result).toBe("composer answer");
  });

  it("COO condition: a background re-invocation (<task-notification>) never opens or queues a wait — no gateway turn parks with nobody at the terminal", async () => {
    const notification = "<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>";
    const waits: boolean[] = [];
    engine.onTerminalWait((_id, waiting) => waits.push(waiting));
    await warmUp("s-bg");
    // Between gateway turns: a background task finishes and claude re-invokes itself.
    deliver("s-bg", { hook_event_name: "UserPromptSubmit", prompt: notification });
    void engine.run({ sessionId: "s-bg", prompt: "composer message", cwd: "/tmp", resumeSessionId: "c1" } as any);
    await vi.advanceTimersByTimeAsync(20);
    // the paste is held until the re-run's own Stop, so the re-run's
    // answer cannot settle the message — but that is not a terminal wait.
    expect(pasted("composer message")).toBe(false);
    expect(waits).toEqual([]);
    deliver("s-bg", { hook_event_name: "Stop", last_assistant_message: "background acknowledged" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pasted("composer message")).toBe(true);
    expect(waits).toEqual([]);
    engine.kill("s-bg");
    await vi.advanceTimersByTimeAsync(10);

    // During a gateway turn: the notification's UPS must not mark a terminal turn queued.
    await warmUp("s-bg2");
    const turn = engine.run({ sessionId: "s-bg2", prompt: "composer message", cwd: "/tmp", resumeSessionId: "c1" } as any);
    await vi.advanceTimersByTimeAsync(200);
    deliver("s-bg2", { hook_event_name: "UserPromptSubmit", prompt: "composer message" });
    deliver("s-bg2", { hook_event_name: "UserPromptSubmit", prompt: notification });
    deliver("s-bg2", { hook_event_name: "Stop", last_assistant_message: "composer answer" });
    expect((await turn).result).toBe("composer answer");
    void engine.run({ sessionId: "s-bg2", prompt: "next message", cwd: "/tmp", resumeSessionId: "c1" } as any);
    await vi.advanceTimersByTimeAsync(20);
    expect(ptys.at(-1)!.writes.some((w) => w.includes("next message"))).toBe(true); // pasted, no wait
    expect(waits).toEqual([]);
    engine.kill("s-bg2");
  });

  describe("typing in the terminal while a gateway turn is held behind a background re-run ", => {
    const notification = "<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>";

    it("the typed prompt is not taken as the gateway turn's own: the turn waits for it, then pastes and settles on its own answer", async () => {
      const waits: boolean[] = [];
      engine.onTerminalWait((_id, waiting) => waits.push(waiting));
      await warmUp("s-hold-typed");
      deliver("s-hold-typed", { hook_event_name: "UserPromptSubmit", prompt: notification });
      const turn = engine.run({ sessionId: "s-hold-typed", prompt: "composer message", cwd: "/tmp", resumeSessionId: "c1" } as any);
      await vi.advanceTimersByTimeAsync(20);
      // The operator types while the re-run runs: queued, its UPS fires at once.
      deliver("s-hold-typed", { hook_event_name: "UserPromptSubmit", prompt: "operator prompt" });
      expect(engine.turnProgress("s-hold-typed")?.awaitingSubmit).toBe(false); // not taken as our acknowledgement
      deliver("s-hold-typed", { hook_event_name: "Stop", last_assistant_message: "background answer" });
      ptys[0]!.emit("✻"); // the operator's turn runs now
      await vi.advanceTimersByTimeAsync(1_500);
      // Not pasted behind the operator's running turn: it is waited for, visibly.
      expect(pasted("composer message")).toBe(false);
      expect(waits).toEqual([true]);
      deliver("s-hold-typed", { hook_event_name: "Stop", last_assistant_message: "operator answer" });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(pasted("composer message")).toBe(true);
      expect(waits).toEqual([true, false]);
      expect(engine.turnProgress("s-hold-typed")?.awaitingSubmit).toBe(true);
      deliver("s-hold-typed", { hook_event_name: "UserPromptSubmit", prompt: "composer message" });
      deliver("s-hold-typed", { hook_event_name: "Stop", last_assistant_message: "composer answer" });
      expect((await turn).result).toBe("composer answer");
      expect(unclaimed.map((u) => u.text)).toEqual(["background answer", "operator answer"]);
    });

    it("the gateway answers the re-run's safety prompts, never those of the operator's typed turn", async () => {
      await warmUp("s-hold-dialog");
      const answer = vi.spyOn(engine as any, "answerPermissionPrompt").mockResolvedValue(undefined);
      deliver("s-hold-dialog", { hook_event_name: "UserPromptSubmit", prompt: notification });
      const turn = engine.run({ sessionId: "s-hold-dialog", prompt: "composer message", cwd: "/tmp", resumeSessionId: "c1" } as any);
      await vi.advanceTimersByTimeAsync(20);
      deliver("s-hold-dialog", { hook_event_name: "Notification", notification_type: "permission_prompt" });
      expect(answer).toHaveBeenCalledTimes(1); // the re-run's: nobody is at the terminal for it
      deliver("s-hold-dialog", { hook_event_name: "UserPromptSubmit", prompt: "operator prompt" });
      deliver("s-hold-dialog", { hook_event_name: "Stop", last_assistant_message: "background answer" });
      deliver("s-hold-dialog", { hook_event_name: "Notification", notification_type: "permission_prompt" });
      expect(answer).toHaveBeenCalledTimes(1); // the operator's: theirs to answer
      deliver("s-hold-dialog", { hook_event_name: "Stop", last_assistant_message: "operator answer" });
      await vi.advanceTimersByTimeAsync(1_000);
      deliver("s-hold-dialog", { hook_event_name: "UserPromptSubmit", prompt: "composer message" });
      deliver("s-hold-dialog", { hook_event_name: "Notification", notification_type: "permission_prompt" });
      expect(answer).toHaveBeenCalledTimes(2); // ours again
      deliver("s-hold-dialog", { hook_event_name: "Stop", last_assistant_message: "composer answer" });
      expect((await turn).result).toBe("composer answer");
    });

    it("stopping the turn while it waits for the typed turn ends only the wait", async () => {
      await warmUp("s-hold-stop");
      deliver("s-hold-stop", { hook_event_name: "UserPromptSubmit", prompt: notification });
      const turn = engine.run({ sessionId: "s-hold-stop", prompt: "composer message", cwd: "/tmp", resumeSessionId: "c1" } as any);
      await vi.advanceTimersByTimeAsync(20);
      deliver("s-hold-stop", { hook_event_name: "UserPromptSubmit", prompt: "operator prompt" });
      deliver("s-hold-stop", { hook_event_name: "Stop", last_assistant_message: "background answer" });
      ptys[0]!.emit("✻");
      await vi.advanceTimersByTimeAsync(1_500);
      engine.kill("s-hold-stop", "Interrupted by user");
      expect((await turn).error).toBe("Interrupted by user");
      expect(pasted("composer message")).toBe(false);
      expect(engine.hasWarmPty("s-hold-stop")).toBe(true); // the operator's turn keeps running
    });

    it("the typed turn waited for after the hold neither streams into the gateway turn nor leaves its tools counted", async () => {
      await warmUp("s-hold-stream");
      const deltas: Array<{ type: string }> = [];
      deliver("s-hold-stream", { hook_event_name: "UserPromptSubmit", prompt: notification });
      const turn = engine.run({
        sessionId: "s-hold-stream", prompt: "composer message", cwd: "/tmp", resumeSessionId: "c1",
        onStream: (d: { type: string }) => deltas.push(d),
      } as any);
      await vi.advanceTimersByTimeAsync(20);
      deliver("s-hold-stream", { hook_event_name: "UserPromptSubmit", prompt: "operator prompt" });
      deliver("s-hold-stream", { hook_event_name: "Stop", last_assistant_message: "background answer" });
      ptys[0]!.emit("✻");
      await vi.advanceTimersByTimeAsync(1_500);
      expect(pasted("composer message")).toBe(false);
      // The operator's turn works: model text, a tool call, a tool it
      // interrupts (PreToolUse with no PostToolUse).
      (engine as any).handleSseEvent("s-hold-stream", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OPERATOR TEXT" } });
      (engine as any).handleSseEvent("s-hold-stream", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu1", name: "Bash" } });
      deliver("s-hold-stream", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "tu1" });
      deliver("s-hold-stream", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "tu1", tool_response: "ok" });
      deliver("s-hold-stream", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "tu2" });
      deliver("s-hold-stream", { hook_event_name: "Stop", last_assistant_message: "operator answer" });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(pasted("composer message")).toBe(true);
      expect(deltas.filter((d) => d.type !== "context")).toEqual([]);
      expect(engine.turnProgress("s-hold-stream")?.activeTools).toBe(0);
      deliver("s-hold-stream", { hook_event_name: "UserPromptSubmit", prompt: "composer message" });
      (engine as any).handleSseEvent("s-hold-stream", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "MINE" } });
      deliver("s-hold-stream", { hook_event_name: "Stop", last_assistant_message: "composer answer" });
      expect((await turn).result).toBe("composer answer");
      expect(deltas.filter((d) => d.type === "text")).toEqual([{ type: "text", content: "MINE" }]);
    });

    it("idle: a second re-run that runs ahead of a queued typed prompt does not end it (QA R6)", async () => {
      await warmUp("s-idle-two");
      deliver("s-idle-two", { hook_event_name: "UserPromptSubmit", prompt: notification });
      deliver("s-idle-two", { hook_event_name: "UserPromptSubmit", prompt: "operator prompt" }); // queued: UPS at once
      deliver("s-idle-two", { hook_event_name: "Stop", last_assistant_message: "bg1" });
      deliver("s-idle-two", { hook_event_name: "UserPromptSubmit", prompt: notification.replace("b1", "b2") });
      deliver("s-idle-two", { hook_event_name: "Stop", last_assistant_message: "bg2" });
      ptys[0]!.emit("✻"); // the operator's turn runs now
      const turn = engine.run({ sessionId: "s-idle-two", prompt: "composer message", cwd: "/tmp", resumeSessionId: "c1" } as any);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(pasted("composer message")).toBe(false);
      deliver("s-idle-two", { hook_event_name: "Stop", last_assistant_message: "operator answer" });
      await vi.advanceTimersByTimeAsync(500);
      expect(pasted("composer message")).toBe(true);
      deliver("s-idle-two", { hook_event_name: "UserPromptSubmit", prompt: "composer message" });
      deliver("s-idle-two", { hook_event_name: "Stop", last_assistant_message: "composer answer" });
      expect((await turn).result).toBe("composer answer");
    });

    it("held: a second re-run that runs ahead of a queued typed prompt does not end it either (QA R7)", async () => {
      await warmUp("s-hold-two");
      const answer = vi.spyOn(engine as any, "answerPermissionPrompt").mockResolvedValue(undefined);
      deliver("s-hold-two", { hook_event_name: "UserPromptSubmit", prompt: notification });
      const turn = engine.run({ sessionId: "s-hold-two", prompt: "composer message", cwd: "/tmp", resumeSessionId: "c1" } as any);
      await vi.advanceTimersByTimeAsync(20);
      deliver("s-hold-two", { hook_event_name: "UserPromptSubmit", prompt: "operator prompt" });
      deliver("s-hold-two", { hook_event_name: "Stop", last_assistant_message: "bg1" });
      deliver("s-hold-two", { hook_event_name: "UserPromptSubmit", prompt: notification.replace("b1", "b2") });
      deliver("s-hold-two", { hook_event_name: "Stop", last_assistant_message: "bg2" });
      ptys[0]!.emit("✻");
      await vi.advanceTimersByTimeAsync(1_500);
      expect(pasted("composer message")).toBe(false);
      deliver("s-hold-two", { hook_event_name: "Notification", notification_type: "permission_prompt" }); // the operator's
      expect(answer).not.toHaveBeenCalled();
      deliver("s-hold-two", { hook_event_name: "Stop", last_assistant_message: "operator answer" });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(pasted("composer message")).toBe(true);
      deliver("s-hold-two", { hook_event_name: "UserPromptSubmit", prompt: "composer message" });
      deliver("s-hold-two", { hook_event_name: "Stop", last_assistant_message: "composer answer" });
      expect((await turn).result).toBe("composer answer");
    });

    it("held: a notification folded into the operator's typed turn does not make the gateway answer that turn's dialogs (QA R8)", async () => {
      await warmUp("s-hold-fold-dialog");
      const answer = vi.spyOn(engine as any, "answerPermissionPrompt").mockResolvedValue(undefined);
      deliver("s-hold-fold-dialog", { hook_event_name: "UserPromptSubmit", prompt: notification });
      const turn = engine.run({ sessionId: "s-hold-fold-dialog", prompt: "composer message", cwd: "/tmp", resumeSessionId: "c1" } as any);
      await vi.advanceTimersByTimeAsync(20);
      deliver("s-hold-fold-dialog", { hook_event_name: "UserPromptSubmit", prompt: "operator prompt" });
      deliver("s-hold-fold-dialog", { hook_event_name: "Stop", last_assistant_message: "bg1" });
      ptys[0]!.emit("✻");
      await vi.advanceTimersByTimeAsync(1_000);
      deliver("s-hold-fold-dialog", { hook_event_name: "PreToolUse", tool_name: "Bash" });
      deliver("s-hold-fold-dialog", { hook_event_name: "UserPromptSubmit", prompt: notification.replace("b1", "b2") }); // folded
      deliver("s-hold-fold-dialog", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_response: "ok" });
      deliver("s-hold-fold-dialog", { hook_event_name: "Notification", notification_type: "permission_prompt" }); // the operator's turn
      expect(answer).not.toHaveBeenCalled();
      deliver("s-hold-fold-dialog", { hook_event_name: "Stop", last_assistant_message: "operator answer" });
      await vi.advanceTimersByTimeAsync(TERMINAL_TURN_QUIET_MS + 16_000); // backstops release the hold
      expect(pasted("composer message")).toBe(true);
      deliver("s-hold-fold-dialog", { hook_event_name: "UserPromptSubmit", prompt: "composer message" });
      deliver("s-hold-fold-dialog", { hook_event_name: "Stop", last_assistant_message: "composer answer" });
      expect((await turn).result).toBe("composer answer");
    });

    it("accepted cost (F5 reverted): a notification folded into a typed turn keeps that turn waited for until the quiet backstop", async () => {
      await warmUp("s-idle-folded");
      deliver("s-idle-folded", { hook_event_name: "UserPromptSubmit", prompt: "operator prompt" });
      deliver("s-idle-folded", { hook_event_name: "PreToolUse", tool_name: "Bash" });
      deliver("s-idle-folded", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_response: "ok" });
      deliver("s-idle-folded", { hook_event_name: "UserPromptSubmit", prompt: notification }); // folded at the tool boundary
      deliver("s-idle-folded", { hook_event_name: "Stop", last_assistant_message: "operator answer" });
      const turn = engine.run({ sessionId: "s-idle-folded", prompt: "composer message", cwd: "/tmp", resumeSessionId: "c1" } as any);
      await vi.advanceTimersByTimeAsync(20);
      expect(pasted("composer message")).toBe(false);
      await vi.advanceTimersByTimeAsync(TERMINAL_TURN_QUIET_MS + 1_000); // silent, no dialog: over
      expect(pasted("composer message")).toBe(true);
      deliver("s-idle-folded", { hook_event_name: "UserPromptSubmit", prompt: "composer message" });
      deliver("s-idle-folded", { hook_event_name: "Stop", last_assistant_message: "composer answer" });
      expect((await turn).result).toBe("composer answer");
    });

    it("idle: a background re-run's Stop does not end a turn typed while it ran (the next gateway turn waits for it)", async () => {
      const waits: boolean[] = [];
      engine.onTerminalWait((_id, waiting) => waits.push(waiting));
      await warmUp("s-idle-typed");
      deliver("s-idle-typed", { hook_event_name: "UserPromptSubmit", prompt: notification });
      deliver("s-idle-typed", { hook_event_name: "UserPromptSubmit", prompt: "operator prompt" });
      deliver("s-idle-typed", { hook_event_name: "Stop", last_assistant_message: "background answer" });
      ptys[0]!.emit("✻");
      const turn = engine.run({ sessionId: "s-idle-typed", prompt: "composer message", cwd: "/tmp", resumeSessionId: "c1" } as any);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(pasted("composer message")).toBe(false);
      expect(waits).toEqual([true]);
      deliver("s-idle-typed", { hook_event_name: "Stop", last_assistant_message: "operator answer" });
      await vi.advanceTimersByTimeAsync(500);
      expect(pasted("composer message")).toBe(true);
      deliver("s-idle-typed", { hook_event_name: "UserPromptSubmit", prompt: "composer message" });
      deliver("s-idle-typed", { hook_event_name: "Stop", last_assistant_message: "composer answer" });
      expect((await turn).result).toBe("composer answer");
    });
  });

  it("QA-R2-1: conversation text quoting \"esc to interrupt\" (or a whole dialog) does not hold the wait", async () => {
    await warmUp("s-qa-quote");
    deliver("s-qa-quote", { hook_event_name: "UserPromptSubmit", prompt: "operator question" });
    // An Esc-interrupted turn (no Stop) whose answer quotes the status line and
    // a safety dialog, with claude's idle input box and status line below.
    ptys[0]!.emit([
      "● The status line reads \"esc to interrupt\" while a turn runs, and a safety prompt looks like:",
      SAFETY_PROMPT_FRAME,
      "",
      "❯ ",
      "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
    ].join("\r\n"));
    const turn = engine.run({ sessionId: "s-qa-quote", prompt: "composer message", cwd: "/tmp", resumeSessionId: "c1" } as any);
    await vi.advanceTimersByTimeAsync(TERMINAL_TURN_QUIET_MS + 1_000);
    expect(pasted("composer message")).toBe(true);
    deliver("s-qa-quote", { hook_event_name: "UserPromptSubmit", prompt: "composer message" });
    deliver("s-qa-quote", { hook_event_name: "Stop", last_assistant_message: "composer answer" });
    expect((await turn).result).toBe("composer answer");
  });

  it("QA-C: a terminal turn blocked on a safety prompt is not idle; once the dialog is gone it is", async () => {
    await warmUp("s-qa-dialog");
    deliver("s-qa-dialog", { hook_event_name: "UserPromptSubmit", prompt: "operator question" });
    deliver("s-qa-dialog", { hook_event_name: "PreToolUse", tool_name: "Bash" });
    ptys[0]!.emit(SAFETY_PROMPT_FRAME);
    deliver("s-qa-dialog", { hook_event_name: "Notification", notification_type: "permission_prompt" });
    const before = ptys[0]!.writes.length;
    void engine.run({ sessionId: "s-qa-dialog", prompt: "composer message", cwd: "/tmp", resumeSessionId: "c1" } as any);
    await vi.advanceTimersByTimeAsync(TERMINAL_TURN_QUIET_MS * 3);
    expect(pasted("composer message")).toBe(false);
    expect(ptys[0]!.writes.slice(before)).toEqual([]); // the gateway did not answer the operator's dialog
    // The operator cancels with Esc: no PostToolUse, no Stop — the dialog just goes.
    ptys[0]!.emit("\x1b[2J\x1b[H❯ ");
    await vi.advanceTimersByTimeAsync(TERMINAL_TURN_QUIET_MS + 1_000);
    expect(pasted("composer message")).toBe(true);
    engine.kill("s-qa-dialog");
  });

  it("QA: a replayed safety-prompt notification is never auto-approved by the gateway turn", async () => {
    await warmUp("s-qa-replay");
    // Cursor on "No", so an approval would have to send an arrow key first.
    ptys[0]!.emit(SAFETY_PROMPT_FRAME.replace(" ❯ 1. Yes", "   1. Yes").replace("   2. No", " ❯ 2. No"));
    // Buffered with no turn registered (and no terminal turn open to wait on).
    deliver("s-qa-replay", { hook_event_name: "Notification", notification_type: "permission_prompt" });
    const turn = engine.run({ sessionId: "s-qa-replay", prompt: "composer message", cwd: "/tmp", resumeSessionId: "c1" } as any);
    await vi.advanceTimersByTimeAsync(3_000);
    deliver("s-qa-replay", { hook_event_name: "UserPromptSubmit", prompt: "composer message" });
    await vi.advanceTimersByTimeAsync(3_000);
    // No keystrokes aimed at the dialog: an approval would move the cursor up to Yes.
    expect(ptys[0]!.writes.some((w) => w.includes("\x1b[A"))).toBe(false);
    deliver("s-qa-replay", { hook_event_name: "Stop", last_assistant_message: "composer answer" });
    await turn;
  });

  it("QA: interrupting a waiting gateway turn ends the wait only — the operator's claude keeps running", async () => {
    await warmUp("s-qa-kill");
    deliver("s-qa-kill", { hook_event_name: "UserPromptSubmit", prompt: "operator question" });
    const turn = engine.run({ sessionId: "s-qa-kill", prompt: "composer message", cwd: "/tmp", resumeSessionId: "c1" } as any);
    ptys[0]!.emit("✻");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(engine.isTurnRunning("s-qa-kill")).toBe(true); // "send now" / stop can reach it
    engine.kill("s-qa-kill", "Interrupted by user");
    const r = await turn;
    expect(r.error).toBe("Interrupted by user");
    expect(pasted("composer message")).toBe(false);
    expect(engine.hasWarmPty("s-qa-kill")).toBe(true);
    expect(engine.isTurnRunning("s-qa-kill")).toBe(false);
    // The operator's turn finishes and still reaches the sync.
    deliver("s-qa-kill", { hook_event_name: "Stop", last_assistant_message: "operator answer" });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(unclaimed).toEqual([{ id: "s-qa-kill", text: "operator answer" }]);
  });

  it("QA-S2: a teardown kill (session deleted / reset / engine switched) while waiting ends the wait AND releases the PTY", async () => {
    for (const reason of [
      "Interrupted: session deleted", "Interrupted: session reset", "Interrupted: engine switched",
      "Interrupted: forking", "Interrupted: workflow attempt stopped", "Interrupted",
    ]) {
      const id = `s-teardown-${reason.replace(/\W+/g, "-")}`;
      await warmUp(id);
      deliver(id, { hook_event_name: "UserPromptSubmit", prompt: "operator question" });
      const turn = engine.run({ sessionId: id, prompt: "composer message", cwd: "/tmp", resumeSessionId: "c1" } as any);
      await vi.advanceTimersByTimeAsync(500);
      engine.kill(id, reason);
      expect((await turn).error).toBe(reason);
      expect(engine.hasWarmPty(id)).toBe(false);
      ptys.length = 0;
    }
  });

  it("QA-S2: the stop button, a new message or 'send now' while waiting ends the wait only", async () => {
    for (const reason of ["Interrupted by user", "Interrupted: new message received"]) {
      const id = `s-waitonly-${reason.replace(/\W+/g, "-")}`;
      await warmUp(id);
      deliver(id, { hook_event_name: "UserPromptSubmit", prompt: "operator question" });
      const turn = engine.run({ sessionId: id, prompt: "composer message", cwd: "/tmp", resumeSessionId: "c1" } as any);
      await vi.advanceTimersByTimeAsync(500);
      engine.kill(id, reason);
      expect((await turn).error).toBe(reason);
      expect(engine.hasWarmPty(id)).toBe(true);
      engine.kill(id, "Interrupted: session deleted");
      ptys.length = 0;
    }
  });

  it("a terminal restart while a gateway turn waits ends the wait AND replaces the PTY", async () => {
    await warmUp("s-restart");
    deliver("s-restart", { hook_event_name: "UserPromptSubmit", prompt: "operator question" });
    const turn = engine.run({ sessionId: "s-restart", prompt: "composer message", cwd: "/tmp", resumeSessionId: "c1" } as any);
    ptys[0]!.emit("✻");
    await vi.advanceTimersByTimeAsync(500);
    engine.restartPty("s-restart", { cols: 80, rows: 24 });
    expect((await turn).error).toMatch(/terminal restart/);
    await vi.advanceTimersByTimeAsync(50);
    expect(ptys.length).toBe(2); // a fresh idle PTY replaced the old one
  });

  it("keeps re-sending the submit CR while only the operator's turn is producing hooks", async () => {
    await warmUp("s-cr");
    const pty = ptys[0]!;
    const crs = () => pty.writes.filter((w) => w === "\r").length;
    void engine.run({ sessionId: "s-cr", prompt: "composer message", cwd: "/tmp", resumeSessionId: "c1" } as any);
    await vi.advanceTimersByTimeAsync(200);
    const afterFirst = crs();
    // A terminal-typed turn's tool hooks are not our acknowledgement.
    deliver("s-cr", { hook_event_name: "PreToolUse", tool_name: "Bash" });
    deliver("s-cr", { hook_event_name: "PostToolUse", tool_name: "Bash" });
    await vi.advanceTimersByTimeAsync(1_600);
    expect(crs()).toBeGreaterThan(afterFirst);
    deliver("s-cr", { hook_event_name: "UserPromptSubmit", prompt: "composer message" });
    const acked = crs();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(crs()).toBe(acked);
  });
});

describe("recoveryFloorMs", () => {
  it("uses the turn start without the gate (cold spawn, native command)", () => {
    expect(recoveryFloorMs(false, 1_000, undefined)).toBe(1_000);
    expect(recoveryFloorMs(false, 1_000, 5_000)).toBe(1_000);
  });

  it("under the gate, only transcript text after our own UserPromptSubmit is ours", () => {
    expect(recoveryFloorMs(true, 1_000, 5_000)).toBe(5_000);
    expect(recoveryFloorMs(true, 1_000, undefined)).toBeUndefined();
  });
});

describe("viewportShowsLiveSafetyPrompt", () => {
  const lines = (text: string) => text.split("\r\n");
  const STATUS = "  ⏵⏵ bypass permissions on (shift+tab to cycle)";
  it("a live dialog: footer after the options, nothing but the status line below", () => {
    expect(viewportShowsLiveSafetyPrompt(lines(SAFETY_PROMPT_FRAME))).toBe(true);
    expect(viewportShowsLiveSafetyPrompt([...lines(SAFETY_PROMPT_FRAME), "", STATUS, ""])).toBe(true);
  });
  it("a quoted dialog with claude's input box below it is not live", () => {
    expect(viewportShowsLiveSafetyPrompt([...lines(SAFETY_PROMPT_FRAME), "", "─".repeat(20), "❯ ", "─".repeat(20), STATUS])).toBe(false);
    expect(viewportShowsLiveSafetyPrompt([...lines(SAFETY_PROMPT_FRAME), "❯ half-typed draft"])).toBe(false);
  });
  it("QA-S4: fails closed — a dialog with a missing or changed footer and no input line below is live", () => {
    expect(viewportShowsLiveSafetyPrompt(lines(SAFETY_PROMPT_FRAME).filter((l) => !l.includes("Esc to cancel")))).toBe(true);
    expect(viewportShowsLiveSafetyPrompt(lines(SAFETY_PROMPT_FRAME).map((l) => l.replace(/Esc to cancel.*/, "Enter to confirm · Esc to go back")))).toBe(true);
    expect(viewportShowsLiveSafetyPrompt([...lines(SAFETY_PROMPT_FRAME).filter((l) => !l.includes("Esc to cancel")), STATUS])).toBe(true);
  });
  it("needs a parseable question and options", () => {
    expect(viewportShowsLiveSafetyPrompt(["the status line reads \"esc to interrupt\"", "❯ "])).toBe(false);
    expect(viewportShowsLiveSafetyPrompt([" Do you want to proceed?", "", "❯ "])).toBe(false);
  });
});
