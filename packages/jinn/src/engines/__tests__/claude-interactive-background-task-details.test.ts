import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InteractiveClaudeEngine } from "../claude-interactive.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";
import { HookRegistry, type HookPayload } from "../../gateway/hook-registry.js";
import type { UpstreamActivityInfo } from "../sse-pty-proxy.js";

describe("InteractiveClaudeEngine — background task details", () => {
  let registry: HookRegistry;
  let engine: InteractiveClaudeEngine;
  let events: Array<UpstreamActivityInfo | null>;

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

  // The "waiting on" view: what each background task is, taken from the hook that launched it.
  describe("background task details", () => {
    const notify = (xml: string) => (engine as unknown as { observeBackgroundWork(id: string, h: HookPayload): void })
      .observeBackgroundWork("s1", { hook_event_name: "UserPromptSubmit", prompt: xml });
    // The CLI re-runs the model for a notification, and that re-run ends with a Stop.
    const settleRerun = () => (engine as unknown as { observeBackgroundWork(id: string, h: HookPayload): void })
      .observeBackgroundWork("s1", { hook_event_name: "Stop" });
    const eventNotice = (taskId: string, event: string) =>
      `<task-notification>\n<task-id>${taskId}</task-id>\n<summary>Monitor event: "watch"</summary>\n<event>${event}</event>\n</task-notification>`;
    const endNotice = (taskId: string) =>
      `<task-notification>\n<task-id>${taskId}</task-id>\n<status>completed</status>\n<summary>Monitor "watch" stream ended</summary>\n</task-notification>`;
    const launchMonitor = (taskId: string, extra: Partial<HookPayload> = {}) => hook({
      hook_event_name: "PostToolUse",
      tool_name: "Monitor",
      tool_input: { description: "  watch the build  ", timeout_ms: 600_000, command: "tail -f build.log" },
      tool_response: { taskId, timeoutMs: 600_000, persistent: false },
      ...extra,
    });
    const tasks = () => engine.backgroundTasks("s1").tasks;

    it("counts a Monitor as a monitor and keeps what it was launched with", () => {
      vi.setSystemTime(new Date("2026-10-15T10:00:00.000Z"));
      launchMonitor("mon-1");

      expect(events.at(-1)).toMatchObject({ activeMonitors: 1, backgroundAgents: 0 });
      expect(tasks()).toEqual([{
        kind: "monitor",
        id: "mon-1",
        description: "watch the build",
        command: "tail -f build.log",
        agentType: null,
        startedAt: "2026-10-15T10:00:00.000Z",
        lastOutput: null,
        timeoutMs: 600_000,
      }]);
    });

    it("names a websocket Monitor by its url", () => {
      hook({
        hook_event_name: "PostToolUse",
        tool_name: "Monitor",
        tool_input: { description: "feed", ws: { url: "wss://feed.example/stream" } },
        tool_response: { taskId: "mon-ws", timeoutMs: 30_000, persistent: false },
      });

      expect(tasks()[0]).toMatchObject({ kind: "monitor", command: "wss://feed.example/stream", timeoutMs: 30_000 });
    });

    it("does not count a Monitor a sub-agent armed: that sub-agent waits on it", () => {
      launchMonitor("mon-1", { agent_id: "agent-1" });

      expect(events).toEqual([]);
      expect(tasks()).toEqual([]);
    });

    it("shows the newest non-empty line of a Monitor event, and an event is not an ending", () => {
      launchMonitor("mon-1");
      vi.setSystemTime(Date.now() + 5_000);
      notify(eventNotice("mon-1", "compiling\nlinked 12 modules\n\n"));

      expect(tasks()[0]!.lastOutput).toEqual({ line: "linked 12 modules", at: new Date(Date.now()).toISOString() });
      vi.advanceTimersByTime(60_000);
      expect(events.at(-1)).toMatchObject({ activeMonitors: 1 });

      notify(eventNotice("mon-1", `${"x".repeat(400)}`));
      expect(tasks()[0]!.lastOutput!.line).toHaveLength(300);
    });

    it("drops a Monitor whose stream ended", () => {
      launchMonitor("mon-1");
      notify(endNotice("mon-1"));
      settleRerun();

      expect(tasks()).toEqual([]);
      vi.advanceTimersByTime(1_000);
      expect(events.at(-1)).toBeNull();
    });

    it("does not read a <status> in a Monitor's own output as the Monitor ending", () => {
      launchMonitor("mon-1");
      notify(eventNotice("mon-1", "<status>ok</status> hello"));

      expect(tasks().map((task) => task.id)).toEqual(["mon-1"]);
      expect(tasks()[0]!.lastOutput!.line).toBe("<status>ok</status> hello");

      notify(endNotice("mon-1"));
      expect(tasks()).toEqual([]);
    });

    it("drops a Monitor whose timeout elapsed, which the CLI announces as one more event", () => {
      launchMonitor("mon-1");
      notify(eventNotice("mon-1", "[Monitor expired after 600s with 3 events delivered. Re-arm it if you still need the watch.]"));
      settleRerun();

      expect(tasks()).toEqual([]);
      vi.advanceTimersByTime(1_000);
      expect(events.at(-1)).toBeNull();
    });

    it("drops a Monitor that TaskStop stopped, and a late event does not bring it back", () => {
      launchMonitor("mon-1");
      hook({
        hook_event_name: "PostToolUse",
        tool_name: "TaskStop",
        tool_input: { task_id: "mon-1" },
        tool_response: { task_id: "mon-1", task_type: "local_bash" },
      });
      notify(eventNotice("mon-1", "tock"));

      expect(tasks()).toEqual([]);
    });

    it("drops a Monitor a TaskOutput found finished", () => {
      launchMonitor("mon-1");
      hook({
        hook_event_name: "PostToolUse",
        tool_name: "TaskOutput",
        tool_input: { task_id: "mon-1" },
        tool_response: { retrieval_status: "success", task: { task_id: "mon-1", status: "killed" } },
      });

      expect(tasks()).toEqual([]);
    });

    it("keeps one Monitor's output apart from another's", () => {
      launchMonitor("mon-1");
      launchMonitor("mon-2");
      notify(eventNotice("mon-2", "ready"));

      expect(tasks().map((task) => [task.id, task.lastOutput?.line ?? null])).toEqual([["mon-1", null], ["mon-2", "ready"]]);
    });

    it("describes a background Bash task and a background sub-agent", () => {
      vi.setSystemTime(new Date("2026-10-15T10:00:00.000Z"));
      hook({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "npm run dev", description: "Dev server", run_in_background: true },
        tool_response: { backgroundTaskId: "bash-1" },
      });
      vi.setSystemTime(new Date("2026-10-15T10:00:01.000Z"));
      hook({
        hook_event_name: "PostToolUse",
        tool_name: "Agent",
        tool_input: { description: "Survey the repo", prompt: "…", subagent_type: "Explore", run_in_background: true },
        tool_response: { isAsync: true, status: "async_launched", agentId: "agent-1", description: "Survey the repo" },
      });

      expect(events.at(-1)).toMatchObject({ activeMonitors: 1, backgroundAgents: 1 });
      expect(tasks()).toEqual([
        { kind: "process", id: "bash-1", description: "Dev server", command: "npm run dev", agentType: null, startedAt: "2026-10-15T10:00:00.000Z", lastOutput: null, timeoutMs: null },
        { kind: "subagent", id: "agent-1", description: "Survey the repo", command: null, agentType: "Explore", startedAt: "2026-10-15T10:00:01.000Z", lastOutput: null, timeoutMs: null },
      ]);
    });

    it("caps a long description and command", () => {
      hook({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "c".repeat(900), description: "d".repeat(900), run_in_background: true },
        tool_response: { backgroundTaskId: "bash-1" },
      });

      expect(tasks()[0]!.description).toHaveLength(200);
      expect(tasks()[0]!.command).toHaveLength(500);
    });

    it("reports an open re-run beside the tasks, and nothing for a session it knows nothing of", () => {
      expect(engine.backgroundTasks("nobody")).toEqual({ tasks: [] });

      notify(eventNotice("mon-1", "tick"));
      expect(engine.backgroundTasks("s1").rerun).toEqual({ startedAt: null });
    });

    it("forgets every detail with the counts when the session's PTY is released", () => {
      launchMonitor("mon-1");
      (engine as unknown as { clearBackground(id: string): void }).clearBackground("s1");

      expect(tasks()).toEqual([]);
    });

    it("forgets a sub-agent that went silent past the backstop but keeps a Monitor", () => {
      engine.backgroundSilenceMs = 60_000;
      launchMonitor("mon-1");
      hook({
        hook_event_name: "PostToolUse",
        tool_name: "Agent",
        tool_input: { description: "explore", prompt: "…", run_in_background: true },
        tool_response: { isAsync: true, status: "async_launched", agentId: "agent-1" },
      });
      vi.advanceTimersByTime(60_000);

      expect(tasks().map((task) => task.id)).toEqual(["mon-1"]);
    });
  });
});
