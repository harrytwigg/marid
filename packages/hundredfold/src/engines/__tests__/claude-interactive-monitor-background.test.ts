import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InteractiveClaudeEngine } from "../claude-interactive.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";
import { HookRegistry, type HookPayload } from "../../gateway/hook-registry.js";
import type { UpstreamActivityInfo } from "../sse-pty-proxy.js";

describe("InteractiveClaudeEngine — background monitors", () => {
  let registry: HookRegistry;
  let engine: InteractiveClaudeEngine;
  let events: Array<UpstreamActivityInfo | null>;

  const notified = (taskIds: string[]) =>
    (engine as unknown as {
      dropBackgroundMonitors(sessionId: string, taskIds: string[]): void;
    }).dropBackgroundMonitors("s1", taskIds);

  const launch = (taskId: string) => hook({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "sleep 600", run_in_background: true },
    tool_response: { backgroundTaskId: taskId },
  });

  const hook = (payload: HookPayload) =>
    (engine as unknown as {
      handleBackgroundMonitorHook(sessionId: string, hook: HookPayload): void;
    }).handleBackgroundMonitorHook("s1", payload);

  beforeEach(() => {
    vi.useFakeTimers();
    registry = new HookRegistry();
    engine = new InteractiveClaudeEngine(
      new PtyLifecycleManager({ maxLivePtys: 4 }),
      registry,
    );
    engine.backgroundClearQuietMs = 1_000;
    events = [];
    engine.onBackgroundActivity((_id, info) => events.push(info));
  });

  afterEach(() => {
    registry.dispose();
    vi.useRealTimers();
  });

  it("reports a top-level background Bash monitor and clears it after TaskStop", () => {
    hook({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "while true; do date; done", run_in_background: true },
      tool_response: { backgroundTaskId: "task-1" },
    });

    expect(events).toEqual([
      expect.objectContaining({
        activeStreams: 0,
        activeAgents: 0,
        activeMonitors: 1,
      }),
    ]);

    hook({
      hook_event_name: "PostToolUse",
      tool_name: "TaskStop",
      tool_input: { task_id: "task-1" },
      tool_response: { task_id: "task-1", task_type: "local_bash" },
    });
    vi.advanceTimersByTime(999);
    expect(events).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(events).toEqual([expect.any(Object), null]);
  });

  it("does not count a background Bash tool owned by a Task subagent as a monitor", () => {
    hook({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      agent_id: "agent-1",
      tool_input: { command: "sleep 60", run_in_background: true },
      tool_response: { backgroundTaskId: "task-1" },
    });

    expect(events).toEqual([]);
  });

  // a background task that ends on its own sends no hook. Its only
  // signal is the task-notification the CLI hands the model, and a monitor
  // that never clears would make every later restart nudge the session.
  it("forgets a background task the CLI announced as finished", () => {
    launch("task-1");
    launch("task-2");
    expect(events.at(-1)).toMatchObject({ activeMonitors: 2 });

    notified(["task-1"]);
    expect(events.at(-1)).toMatchObject({ activeMonitors: 1 });

    notified(["task-2"]);
    vi.advanceTimersByTime(1_000);
    expect(events.at(-1)).toBeNull();
  });

  it("ignores notifications for tasks it never counted", () => {
    launch("task-1");
    const before = events.length;

    notified(["agent-7", "monitor-3"]);

    expect(events).toHaveLength(before);
    vi.advanceTimersByTime(5_000);
    expect(events.at(-1)).toMatchObject({ activeMonitors: 1 });
  });

  describe("background sub-agents", () => {
    const launchAgent = (agentId: string, extra: Partial<HookPayload> = {}) => hook({
      hook_event_name: "PostToolUse",
      tool_name: "Agent",
      tool_input: { description: "explore", prompt: "…", run_in_background: true },
      tool_response: { isAsync: true, status: "async_launched", agentId },
      ...extra,
    });

    it("counts an agent launched in the background until a notification announces it", () => {
      launchAgent("agent-1");
      expect(events.at(-1)).toMatchObject({ backgroundAgents: 1 });

      notified(["agent-1"]);
      // Its end is reported at once, not after the quiet window: the session
      // stops reading as running the moment its work is done.
      expect(events.at(-1)).toMatchObject({ backgroundAgents: 0 });
      vi.advanceTimersByTime(1_000);
      expect(events.at(-1)).toBeNull();
    });

    it("forgets an agent a TaskOutput found finished, which no notification will announce", () => {
      launchAgent("agent-1");
      hook({
        hook_event_name: "PostToolUse",
        tool_name: "TaskOutput",
        tool_input: { task_id: "agent-1", block: true },
        tool_response: { retrieval_status: "timeout", task: { task_id: "agent-1", task_type: "local_agent", status: "running" } },
      });
      expect(events.at(-1)).toMatchObject({ backgroundAgents: 1 });

      hook({
        hook_event_name: "PostToolUse",
        tool_name: "TaskOutput",
        tool_input: { task_id: "agent-1", block: true },
        tool_response: { retrieval_status: "success", task: { task_id: "agent-1", task_type: "local_agent", status: "completed" } },
      });
      expect(events.at(-1)).toMatchObject({ backgroundAgents: 0 });
    });

    it("does not count an agent a sub-agent launched: that sub-agent waits on it", () => {
      launchAgent("agent-2", { agent_id: "agent-1" });
      expect(events).toEqual([]);
    });

    it("does not count a foreground agent call", () => {
      hook({
        hook_event_name: "PostToolUse",
        tool_name: "Agent",
        tool_input: { description: "explore", prompt: "…" },
        tool_response: { status: "completed", content: [] },
      });
      expect(events).toEqual([]);
    });

    it("stops counting an agent that has gone silent past the backstop with no end reported", () => {
      engine.backgroundSilenceMs = 60_000;
      launchAgent("agent-1");
      vi.advanceTimersByTime(59_000);
      // A sub-agent's tool hook is a sign of life: the backstop starts over.
      (engine as unknown as { observeBackgroundWork(id: string, h: HookPayload): void })
        .observeBackgroundWork("s1", { hook_event_name: "PostToolUse", agent_id: "agent-1", tool_name: "Read" });
      vi.advanceTimersByTime(59_000);
      expect(events.at(-1)).toMatchObject({ backgroundAgents: 1 });

      vi.advanceTimersByTime(1_000);
      expect(events.at(-1)).toMatchObject({ backgroundAgents: 0 });
    });
  });
});
