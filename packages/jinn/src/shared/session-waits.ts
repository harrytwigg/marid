/**
 * What a session is waiting on, item by item: the contract of
 * `GET /api/sessions/:id/waits`. The session payloads carry counts only; this
 * is fetched while the "waiting on" popup is open.
 */

/** A task the engine launched in the background and has not seen end. */
export interface BackgroundTaskWait {
  /** Claude Monitor tool / background Bash / background Agent or Task. */
  kind: "monitor" | "process" | "subagent";
  /** The engine's task id: a Monitor's taskId, a Bash backgroundTaskId, an agentId. */
  id: string;
  /** tool_input.description, trimmed, at most 200 characters. */
  description: string | null;
  /** monitor/process: tool_input.command (or the ws url of a ws Monitor), at most 500 characters; subagent: null. */
  command: string | null;
  /** subagent only: tool_input.subagent_type. */
  agentType: string | null;
  /** ISO instant the gateway saw the launch. */
  startedAt: string;
  /** monitor only: the newest event line, trimmed, at most 300 characters. */
  lastOutput: { line: string; at: string } | null;
  /** monitor only: tool_input.timeout_ms. */
  timeoutMs: number | null;
}

/** A background re-invocation the engine has open. */
export interface RerunWait {
  kind: "rerun";
  startedAt: string | null;
}

/** What an engine reports for a session through `backgroundTasks`. */
export interface BackgroundTasksReport {
  tasks: BackgroundTaskWait[];
  /** The ISO start of an open re-run (null when unknown), or undefined when none is open. */
  rerun?: { startedAt: string | null };
}

/** An engine that can say, per session, which background tasks it is waiting on. */
export interface BackgroundTasksSource {
  backgroundTasks(sessionId: string): BackgroundTasksReport;
}

export function isBackgroundTasksSource(engine: object): engine is BackgroundTasksSource {
  return typeof (engine as Partial<BackgroundTasksSource>).backgroundTasks === "function";
}

export interface DelegatedSessionWait {
  kind: "session";
  sessionId: string;
  /** The session it reports to: the response's own sessionId for a direct child. */
  reportsTo: string;
  /** Todo execution attempt / Todo review / no Todo (spawn_session, consult). */
  relation: "delegated" | "review" | "session";
  /** The caller may not read it: employee, title and todo are null and nothing may link it. */
  restricted: boolean;
  employee: string | null;
  employeeDisplayName: string | null;
  title: string | null;
  todo: { id: string; title: string } | null;
  /** Effective status, the background overlay applied. */
  status: "running" | "waiting" | "idle" | "error" | "interrupted";
  /** Holds engine capacity now: the same test the delegated-activity count uses. */
  active: boolean;
  /** Start of its open Todo run if it has one, else its creation. */
  since: string;
  /** Inactive only: its stored lastActivity. */
  endedAt: string | null;
  archived: boolean;
}

export interface HeartbeatWait {
  kind: "heartbeat";
  id: string;
  /** At most 200 characters. */
  message: string;
  everySeconds: number;
  nextFireAt: string;
  fireCount: number;
  maxFires: number | null;
}

export type SessionWaitItem = BackgroundTaskWait | RerunWait | DelegatedSessionWait | HeartbeatWait;

export interface SessionWaitsResponse {
  sessionId: string;
  generatedAt: string;
  items: SessionWaitItem[];
}
