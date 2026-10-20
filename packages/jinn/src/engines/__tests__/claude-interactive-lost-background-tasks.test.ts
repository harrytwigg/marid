import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// node-pty loads a native module at import time; nothing here spawns.
vi.mock("node-pty", () => ({ spawn: vi.fn() }));

import { InteractiveClaudeEngine } from "../claude-interactive.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";
import { HookRegistry, type HookPayload } from "../../gateway/hook-registry.js";
import type { BackgroundTaskWait } from "../../shared/session-waits.js";

function fakeHandle() {
  const h: any = { killed: false, pid: Math.floor(Math.random() * 9999) };
  h.kill = () => { h.killed = true; };
  return h;
}

describe("InteractiveClaudeEngine — background tasks lost with the process", () => {
  let registry: HookRegistry;
  let lifecycle: PtyLifecycleManager;
  let engine: InteractiveClaudeEngine;
  let lost: Array<{ sessionId: string; tasks: BackgroundTaskWait[] }>;

  const hook = (payload: HookPayload) =>
    (engine as unknown as { handleBackgroundMonitorHook(sessionId: string, hook: HookPayload): void })
      .handleBackgroundMonitorHook("s1", payload);

  const launchBash = (taskId: string, command: string) => hook({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command, description: `run ${taskId}`, run_in_background: true },
    tool_response: { backgroundTaskId: taskId },
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));
    registry = new HookRegistry();
    lifecycle = new PtyLifecycleManager({ maxLivePtys: 8 });
    engine = new InteractiveClaudeEngine(lifecycle, registry);
    lost = [];
    engine.onLostBackgroundTasks((sessionId, tasks) => lost.push({ sessionId, tasks }));
    lifecycle.adopt("s1", fakeHandle());
  });

  afterEach(() => {
    registry.dispose();
    vi.useRealTimers();
  });

  it("reports every live task once when the process goes away, and forgets them", () => {
    launchBash("bk2tests1", "npm test");
    vi.advanceTimersByTime(1_000);
    launchBash("bk2build2", "npm run build");
    expect(engine.backgroundTasks("s1").tasks).toHaveLength(2);

    // The funnel for a process exit, an idle-cap eviction and a cold respawn alike.
    lifecycle.releaseSession("s1");

    expect(lost).toHaveLength(1);
    expect(lost[0].sessionId).toBe("s1");
    expect(lost[0].tasks.map((task) => [task.id, task.kind, task.command])).toEqual([
      ["bk2tests1", "process", "npm test"],
      ["bk2build2", "process", "npm run build"],
    ]);
    expect(engine.backgroundTasks("s1").tasks).toEqual([]);

    // A second release of the same session finds nothing more to report.
    lifecycle.adopt("s1", fakeHandle());
    lifecycle.releaseSession("s1");
    expect(lost).toHaveLength(1);
  });

  it("reports nothing when the process ends with no live tasks", () => {
    launchBash("done-1", "true");
    hook({
      hook_event_name: "PostToolUse",
      tool_name: "TaskStop",
      tool_input: { task_id: "done-1" },
      tool_response: { task_id: "done-1", task_type: "local_bash" },
    });

    lifecycle.releaseSession("s1");

    expect(lost).toEqual([]);
  });

  it("reports nothing when the session is stopped on purpose, but still forgets the tasks", () => {
    launchBash("t-1", "sleep 600");

    engine.kill("s1", "Interrupted: stopped by the operator");

    expect(lost).toEqual([]);
    expect(engine.backgroundTasks("s1").tasks).toEqual([]);

    // The next release that is not a kill reports again.
    lifecycle.adopt("s1", fakeHandle());
    launchBash("t-2", "sleep 600");
    lifecycle.releaseSession("s1");
    expect(lost.map((entry) => entry.tasks.map((task) => task.id))).toEqual([["t-2"]]);
  });

  it("reports nothing while the gateway shuts down", () => {
    launchBash("t-1", "sleep 600");

    engine.killAll();

    expect(lost).toEqual([]);
    expect(engine.backgroundTasks("s1").tasks).toEqual([]);
  });

  it("puts a PTY with a live background Bash at the back of the idle cap's queue", () => {
    expect(lifecycle.idleCandidates()[0].holdsBackgroundTasks).toBe(false);
    launchBash("t-1", "sleep 600");
    expect(lifecycle.idleCandidates()[0].holdsBackgroundTasks).toBe(true);
    hook({
      hook_event_name: "PostToolUse",
      tool_name: "TaskStop",
      tool_input: { task_id: "t-1" },
      tool_response: { task_id: "t-1", task_type: "local_bash" },
    });
    expect(lifecycle.idleCandidates()[0].holdsBackgroundTasks).toBe(false);
  });
});
