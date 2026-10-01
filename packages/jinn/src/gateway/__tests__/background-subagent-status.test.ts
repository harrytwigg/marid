import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * A session whose turn ends while its background sub-agents work must read as
 * `running` until they, and the re-run they wake, are done — then `idle`.
 *
 * Before this, the gateway saw only the turn: the session went `idle` at its
 * Stop, and its lastActivity froze there, while the sub-agents worked on and
 * Claude Code re-ran the model on its own to act on their results. Anything
 * reading status to decide whether work was alive took it for a stall.
 *
 * Driven end to end through the real HookRegistry, engine, runtime-activity
 * handler and session serialization, with the hook sequence Claude Code sends
 * (verified on 2.1.283): the turn's Stop with a background agent open, the
 * agent's own tool hooks (carrying agent_id), the `<task-notification>`
 * UserPromptSubmit that opens the re-run, the re-run's tool hooks, its Stop.
 */

interface FakePty {
  pid: number;
  writes: string[];
  onData: (cb: (d: string) => void) => { dispose(): void };
  onExit: (cb: (e: { exitCode: number }) => void) => void;
  kill: (signal?: string) => void;
  write: (d: string) => void;
  resize: (c: number, r: number) => void;
  on: (event: string, cb: (...a: any[]) => void) => void;
}

vi.mock("node-pty", () => ({
  spawn: vi.fn(() => {
    const p: FakePty = {
      pid: 4100,
      writes: [],
      onData() { return { dispose() {} }; },
      onExit() {},
      kill() {},
      write(d: string) { p.writes.push(d); },
      resize() {},
      on() {},
    };
    return p;
  }),
}));
vi.mock("../../engines/sse-pty-proxy.js", () => ({
  MAIN_AGENT_SENTINEL: "<!-- jinn-main-agent:5c1f -->",
  SsePtyProxy: class {
    port = 0;
    async start() { return 41300; }
    stop() {}
  },
}));
vi.mock("../../shared/claude-settings.js", () => ({
  writeSessionSettings: () => "/tmp/fake-settings.json",
  cleanupSessionSettings: () => {},
}));

import { InteractiveClaudeEngine } from "../../engines/claude-interactive.js";
import { PtyLifecycleManager } from "../../engines/pty-lifecycle.js";
import { HookRegistry, type HookPayload } from "../hook-registry.js";
import { createRuntimeActivityHandler } from "../runtime-activity.js";
import { serializeSession, type ApiContext } from "../api.js";
import type { RuntimeActivityInfo } from "../../sessions/background-work.js";
import type { Session } from "../../shared/types.js";

const SID = "s-bg";
const T0 = new Date("2026-10-01T20:00:00.000Z").getTime();
const at = (ms: number) => new Date(ms).toISOString();

const agentLaunched: HookPayload = {
  hook_event_name: "PostToolUse",
  tool_name: "Agent",
  tool_input: { description: "Map the call sites", prompt: "…", run_in_background: true },
  tool_response: { isAsync: true, status: "async_launched", agentId: "a1b2c3", description: "Map the call sites" },
};
const subagentTool = (event: "PreToolUse" | "PostToolUse"): HookPayload => ({
  hook_event_name: event,
  agent_id: "a1b2c3",
  tool_name: "Grep",
  tool_input: { pattern: "lastActivity" },
});
const NOTIFICATION = "<task-notification>\n<task-id>a1b2c3</task-id>\n<tool-use-id>toolu_01</tool-use-id>\n"
  + "<status>completed</status>\n<summary>Agent \"Map the call sites\" completed</summary>\n</task-notification>";
const rerunTool = (event: "PreToolUse" | "PostToolUse"): HookPayload => ({
  hook_event_name: event,
  tool_name: "Edit",
  tool_input: { file_path: "src/a.ts" },
});

describe("a session with background sub-agents still working", () => {
  let registry: HookRegistry;
  let engine: InteractiveClaudeEngine;
  let session: Session;
  let activity: Map<string, RuntimeActivityInfo>;
  let context: ApiContext;
  let unclaimed: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    registry = new HookRegistry();
    unclaimed = [];
    registry.setUnclaimedHookHandler((_id, h) => unclaimed.push(String(h.last_assistant_message ?? "")));
    engine = new InteractiveClaudeEngine(new PtyLifecycleManager({ maxLivePtys: 4 }), registry);
    session = {
      id: SID, engine: "claude", engineSessionId: null, source: "web", sourceRef: `web:${SID}`,
      connector: "web", sessionKey: `web:${SID}`, replyContext: null, messageId: null,
      transportMeta: null, employee: null, model: null, title: null, parentSessionId: null,
      status: "idle", effortLevel: null, totalCost: 0, totalTurns: 0, lastContextTokens: null,
      createdAt: at(T0), lastActivity: at(T0), lastError: null,
    };
    activity = new Map();
    engine.onRuntimeActivity(createRuntimeActivityHandler({
      activity,
      getSession: () => session,
      transportState: (s) => (s.status === "running" ? "running" : "idle"),
      setLastActivity: (_id, iso) => { session = { ...session, lastActivity: iso }; },
      emit: () => {},
    }));
    context = {
      backgroundActivity: activity,
      sessionManager: {
        getQueue: () => ({
          getPendingCount: () => 0,
          getTransportState: (_key: string, status: string) => (status === "running" ? "running" : "idle"),
        }),
        getEngine: () => undefined,
      },
    } as unknown as ApiContext;
  });

  afterEach(() => {
    registry.dispose();
    vi.useRealTimers();
  });

  /** What list_sessions / read_session / the session list report. */
  const reported = () => serializeSession(session, context);

  it("reads running until the sub-agent and its re-run finish, with lastActivity following the work", async () => {
    // The gateway turn: it launches a background agent and ends.
    session = { ...session, status: "running" };
    const turn = engine.run({ sessionId: SID, prompt: "map the call sites in the background", cwd: "/tmp" } as any);
    await vi.advanceTimersByTimeAsync(20);
    registry.deliver(SID, { hook_event_name: "SessionStart", session_id: "claude-1" });
    registry.deliver(SID, { hook_event_name: "UserPromptSubmit", prompt: "map the call sites in the background" });
    registry.deliver(SID, { hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: agentLaunched.tool_input });
    registry.deliver(SID, agentLaunched);
    registry.deliver(SID, { hook_event_name: "Stop", session_id: "claude-1", last_assistant_message: "Waiting on the mapping agent." });
    expect((await turn).result).toBe("Waiting on the mapping agent.");
    // The manager settles the turn: stored status idle, lastActivity the turn's end.
    const turnEndedAt = Date.now();
    session = { ...session, status: "idle", lastActivity: at(turnEndedAt) };

    // 1. Stop with a background agent open: running, not idle.
    expect(reported()).toMatchObject({
      status: "running",
      transportState: "running",
      lastActivity: at(turnEndedAt),
      backgroundActivity: { backgroundAgents: 1, backgroundRerun: false },
    });

    // 2. The agent works for minutes between model requests (none in flight
    //    here). Its tool hooks move lastActivity; nothing lets it lapse to idle.
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(reported().status).toBe("running");
    registry.deliver(SID, subagentTool("PreToolUse"));
    const agentToolAt = Date.now();
    await vi.advanceTimersByTimeAsync(90_000);
    registry.deliver(SID, subagentTool("PostToolUse"));
    const agentDoneAt = Date.now();
    expect(reported()).toMatchObject({ status: "running", lastActivity: at(agentDoneAt) });
    expect(session.lastActivity).toBe(at(agentDoneAt)); // stored too, for the registry's readers
    expect(agentDoneAt).toBeGreaterThan(agentToolAt);

    // 3. The agent finishes; Claude Code re-runs the model with its notification.
    await vi.advanceTimersByTimeAsync(60_000);
    registry.deliver(SID, { hook_event_name: "UserPromptSubmit", prompt: NOTIFICATION });
    const rerunAt = Date.now();
    expect(reported()).toMatchObject({
      status: "running",
      lastActivity: at(rerunAt),
      backgroundActivity: { backgroundAgents: 0, backgroundRerun: true },
    });

    // 4. The re-run works: its tool hooks keep lastActivity current.
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    registry.deliver(SID, rerunTool("PreToolUse"));
    await vi.advanceTimersByTimeAsync(30_000);
    registry.deliver(SID, rerunTool("PostToolUse"));
    const rerunToolAt = Date.now();
    expect(reported()).toMatchObject({ status: "running", lastActivity: at(rerunToolAt) });
    expect(session.lastActivity).toBe(at(rerunToolAt));

    // 5. The re-run's Stop: idle at once, not after the quiet window, with the
    //    stored lastActivity saying when the work ended.
    await vi.advanceTimersByTimeAsync(3_000);
    registry.deliver(SID, { hook_event_name: "Stop", session_id: "claude-1", last_assistant_message: "Mapped 14 call sites; updated src/a.ts." });
    const rerunEndedAt = Date.now();
    expect(reported()).toMatchObject({ status: "idle", transportState: "idle", lastActivity: at(rerunEndedAt) });
    expect(session.lastActivity).toBe(at(rerunEndedAt));

    // The re-run's reply reaches the session through the unclaimed-Stop sync.
    await vi.advanceTimersByTimeAsync(engine.backgroundClearQuietMs);
    expect(unclaimed).toEqual(["Mapped 14 call sites; updated src/a.ts."]);
    expect(reported()).toMatchObject({ status: "idle", backgroundActivity: null });
  });

  it("does not report a session running once its background work is over, before any re-run", async () => {
    // An agent the model stopped itself: nothing will wake the session.
    session = { ...session, status: "running" };
    const turn = engine.run({ sessionId: SID, prompt: "start and stop an agent", cwd: "/tmp" } as any);
    await vi.advanceTimersByTimeAsync(20);
    registry.deliver(SID, { hook_event_name: "SessionStart", session_id: "claude-1" });
    registry.deliver(SID, { hook_event_name: "UserPromptSubmit", prompt: "start and stop an agent" });
    registry.deliver(SID, agentLaunched);
    registry.deliver(SID, { hook_event_name: "PostToolUse", tool_name: "TaskStop", tool_input: { task_id: "a1b2c3" } });
    registry.deliver(SID, { hook_event_name: "Stop", session_id: "claude-1", last_assistant_message: "Stopped it." });
    await turn;
    session = { ...session, status: "idle" };

    expect(reported().status).toBe("idle");
  });

  /** The per-PTY proxy reporting its in-flight requests (mocked out above). */
  const upstream = (activeStreams: number, activeAgents: number) =>
    (engine as unknown as { handleUpstreamActivity(id: string, info: RuntimeActivityInfo): void })
      .handleUpstreamActivity(SID, { activeStreams, activeAgents, lastActivityAt: Date.now() });

  async function settleTurnWithAgent(): Promise<void> {
    session = { ...session, status: "running" };
    const turn = engine.run({ sessionId: SID, prompt: "map the call sites in the background", cwd: "/tmp" } as any);
    await vi.advanceTimersByTimeAsync(20);
    registry.deliver(SID, { hook_event_name: "SessionStart", session_id: "claude-1" });
    registry.deliver(SID, { hook_event_name: "UserPromptSubmit", prompt: "map the call sites in the background" });
    registry.deliver(SID, agentLaunched);
    registry.deliver(SID, { hook_event_name: "Stop", session_id: "claude-1", last_assistant_message: "Waiting." });
    await turn;
    session = { ...session, status: "idle" };
  }

  it("is idle at the re-run's Stop even while the proxy still counts its last request", async () => {
    await settleTurnWithAgent();
    registry.deliver(SID, { hook_event_name: "UserPromptSubmit", prompt: NOTIFICATION });
    upstream(1, 1);
    expect(reported().status).toBe("running");

    // Claude Code fires the Stop hook before the proxy sees the response end.
    registry.deliver(SID, { hook_event_name: "Stop", session_id: "claude-1", last_assistant_message: "Done." });
    expect(reported().status).toBe("idle");
    upstream(0, 0);
    expect(reported().status).toBe("idle");
  });

  it("does not report a finished turn running for a model request sent after its Stop", async () => {
    session = { ...session, status: "running" };
    const turn = engine.run({ sessionId: SID, prompt: "answer", cwd: "/tmp" } as any);
    await vi.advanceTimersByTimeAsync(20);
    registry.deliver(SID, { hook_event_name: "SessionStart", session_id: "claude-1" });
    registry.deliver(SID, { hook_event_name: "Stop", session_id: "claude-1", last_assistant_message: "Answered." });
    await turn;
    session = { ...session, status: "idle" };

    upstream(1, 1);
    expect(reported()).toMatchObject({ status: "idle", transportState: "running" });
    upstream(0, 0);
    expect(reported().status).toBe("idle");
  });
});

