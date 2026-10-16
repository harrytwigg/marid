import type { HookPayload } from "../gateway/hook-registry.js";
import type { BackgroundTaskWait } from "../shared/session-waits.js";
import { monitorEventNotices } from "./task-notifications.js";

/** One background task the engine is waiting on, as the hook stream described its launch. */
interface TaskRecord {
  kind: BackgroundTaskWait["kind"];
  id: string;
  description: string | null;
  command: string | null;
  agentType: string | null;
  startedAt: number;
  lastOutput: { line: string; at: number } | null;
  timeoutMs: number | null;
}

export type LaunchedTask = Omit<TaskRecord, "lastOutput">;

const DESCRIPTION_MAX = 200;
const COMMAND_MAX = 500;

function clip(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text.slice(0, max) : null;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** A Monitor watches a command, or a websocket. */
function monitorCommand(input: Record<string, unknown> | undefined): string | null {
  return clip(input?.command, COMMAND_MAX) ?? clip(record(input?.ws)?.url, COMMAND_MAX);
}

type Fields = Record<string, unknown> | undefined;

function launchedProcess(input: Fields, response: Fields, base: Pick<LaunchedTask, "description" | "startedAt">): LaunchedTask | null {
  if (input?.run_in_background !== true || typeof response?.backgroundTaskId !== "string") return null;
  return { ...base, kind: "process", id: response.backgroundTaskId, command: clip(input.command, COMMAND_MAX), agentType: null, timeoutMs: null };
}

/** The timeout the Monitor runs under. The CLI's answer wins over what was asked: it caps the request
 *  (10 or 30 minutes when bounded) and answers 0 for a persistent Monitor, which has none. */
function monitorTimeout(input: Fields, response: Fields): number | null {
  const timeout = typeof response?.timeoutMs === "number" ? response.timeoutMs : input?.timeout_ms;
  return typeof timeout === "number" && timeout > 0 && response?.persistent !== true ? timeout : null;
}

function launchedMonitor(input: Fields, response: Fields, base: Pick<LaunchedTask, "description" | "startedAt">): LaunchedTask | null {
  if (typeof response?.taskId !== "string") return null;
  return { ...base, kind: "monitor", id: response.taskId, command: monitorCommand(input), agentType: null, timeoutMs: monitorTimeout(input, response) };
}

function launchedSubagent(input: Fields, response: Fields, base: Pick<LaunchedTask, "description" | "startedAt">): LaunchedTask | null {
  if (response?.status !== "async_launched" || typeof response.agentId !== "string") return null;
  return {
    ...base, kind: "subagent", id: response.agentId, command: null, timeoutMs: null,
    description: base.description ?? clip(response.description, DESCRIPTION_MAX),
    agentType: clip(input?.subagent_type, DESCRIPTION_MAX),
  };
}

/** The background task a top-level PostToolUse launched, or null for any other hook. Facts from the
 *  CLI (2.1.300): background Bash answers `backgroundTaskId`; a Monitor answers `taskId`; a
 *  background Agent/Task answers `status: "async_launched"` with its `agentId`. A launch inside a
 *  sub-agent carries `agent_id`: that sub-agent waits on it, so it is not the session's. */
export function launchedBackgroundTask(hook: HookPayload, now: number): LaunchedTask | null {
  if (hook.hook_event_name !== "PostToolUse" || typeof hook.agent_id === "string") return null;
  const input = record(hook.tool_input);
  const response = record(hook.tool_response);
  const base = { description: clip(input?.description, DESCRIPTION_MAX), startedAt: now };
  if (hook.tool_name === "Bash") return launchedProcess(input, response, base);
  if (hook.tool_name === "Monitor") return launchedMonitor(input, response, base);
  if (hook.tool_name === "Agent" || hook.tool_name === "Task") return launchedSubagent(input, response, base);
  return null;
}

/** How long past its timeout a Monitor is still believed: the CLI's own notice normally ends it first. */
export const MONITOR_DEADLINE_SLACK_MS = 60_000;

/** The background tasks each session is waiting on, with what is known of each. In memory only. */
export class BackgroundTaskStore {
  private readonly bySession = new Map<string, Map<string, TaskRecord>>();
  /** A timed Monitor's backstop: the CLI kills it at its timeout, so it is over by then whether or
   *  not the notice saying so was seen. */
  private readonly deadlines = new Map<string, NodeJS.Timeout>();

  /** `onOverdue` hears of a Monitor dropped at its deadline. */
  constructor(private readonly onOverdue: (sessionId: string, taskId: string) => void = () => {}) {}

  /** False when the task was already known. */
  add(sessionId: string, task: LaunchedTask): boolean {
    const tasks = this.bySession.get(sessionId) ?? new Map<string, TaskRecord>();
    if (tasks.has(task.id)) return false;
    tasks.set(task.id, { ...task, lastOutput: null });
    this.bySession.set(sessionId, tasks);
    if (task.kind === "monitor" && task.timeoutMs !== null) this.armDeadline(sessionId, task.id, task.timeoutMs);
    return true;
  }

  private armDeadline(sessionId: string, taskId: string, timeoutMs: number): void {
    const timer = setTimeout(() => {
      if (this.drop(sessionId, [taskId])) this.onOverdue(sessionId, taskId);
    }, timeoutMs + MONITOR_DEADLINE_SLACK_MS);
    timer.unref?.();
    this.deadlines.set(deadlineKey(sessionId, taskId), timer);
  }

  private disarm(sessionId: string, taskId: string): void {
    const key = deadlineKey(sessionId, taskId);
    clearTimeout(this.deadlines.get(key));
    this.deadlines.delete(key);
  }

  /** Forget tasks; true when any was known. Unknown ids are ignored. */
  drop(sessionId: string, taskIds: readonly string[]): boolean {
    const tasks = this.bySession.get(sessionId);
    if (!tasks) return false;
    let dropped = false;
    for (const id of taskIds) {
      if (!tasks.delete(id)) continue;
      this.disarm(sessionId, id);
      dropped = true;
    }
    if (tasks.size === 0) this.bySession.delete(sessionId);
    return dropped;
  }

  /** Apply the Monitor events a notification carries: the newest line is what the task last said.
   *  Returns the Monitors whose timeout notice this was, which have ended. An event for a task the
   *  store does not hold (one already stopped whose last event was still in flight) is not brought back. */
  noteMonitorEvents(sessionId: string, notificationText: string, now: number): string[] {
    const expired: string[] = [];
    for (const { taskId, line, expired: timedOut } of monitorEventNotices(notificationText)) {
      const task = this.bySession.get(sessionId)?.get(taskId);
      if (task?.kind !== "monitor") continue;
      if (timedOut) expired.push(taskId);
      else if (line) task.lastOutput = { line, at: now };
    }
    return expired;
  }

  count(sessionId: string, ...kinds: Array<TaskRecord["kind"]>): number {
    let count = 0;
    for (const task of this.bySession.get(sessionId)?.values() ?? []) if (kinds.includes(task.kind)) count += 1;
    return count;
  }

  clear(sessionId: string, ...kinds: Array<TaskRecord["kind"]>): void {
    const tasks = this.bySession.get(sessionId);
    if (!tasks) return;
    const ids = [...tasks.values()].filter((task) => kinds.length === 0 || kinds.includes(task.kind)).map((task) => task.id);
    this.drop(sessionId, ids);
  }

  /** Oldest launch first, then id. */
  list(sessionId: string): BackgroundTaskWait[] {
    return [...this.bySession.get(sessionId)?.values() ?? []]
      .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
      .map((task) => ({
        ...task,
        startedAt: new Date(task.startedAt).toISOString(),
        lastOutput: task.lastOutput ? { line: task.lastOutput.line, at: new Date(task.lastOutput.at).toISOString() } : null,
      }));
  }
}

function deadlineKey(sessionId: string, taskId: string): string {
  return `${sessionId}\0${taskId}`;
}
