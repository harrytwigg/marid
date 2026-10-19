import type { BoardHookEvent } from "../shared/board-hooks-config.js";

/** Most hooks one causal chain may pass through, re-entry or not (docs/board-hooks.md, Loop guard). */
export const MAX_HOOK_CHAIN = 5;

export interface HookActor {
  /** As recorded on the event row (or the comment's author, for a comment). */
  raw: string | null;
  kind: "operator" | "employee" | "system";
  employee?: string;
  sessionId?: string;
}

/** The fields of a payload that do not depend on which hook is being fired. */
export interface BasePayload {
  version: 1;
  event: BoardHookEvent;
  eventId: string;
  at: string;
  todo: {
    id: string;
    title: string;
    status: string;
    department: string | null;
    labels: string[];
    assignee: string | null;
    parentId: string | null;
    rootId: string;
    childIds: string[];
    url: string;
  };
  from: string | null;
  to: string | null;
  actor: HookActor;
  text: string | null;
  prUrl: string | null;
  sessionId: string | null;
}

export interface HookPayload extends BasePayload {
  fireId: string;
  hook: string;
  /** The hooks this firing passes through, oldest first, ending with this hook. */
  chain: string[];
}

export type HookRunStatus = "running" | "ok" | "error" | "suppressed" | "interrupted";
export type HookRunAction = "spawn" | "command" | "notify" | "none";

export interface HookRun {
  id: string;
  fireId: string;
  hook: string;
  event: string;
  eventId: string;
  todoId: string;
  action: HookRunAction;
  status: HookRunStatus;
  sessionId: string | null;
  exitCode: number | null;
  error: string | null;
  /** Detail reads only. */
  output?: string | null;
  payload?: unknown;
  chain: string[];
  startedAt: string;
  finishedAt: string | null;
  startedMs: number;
}

/** How an action ended. */
export interface ActionOutcome {
  status: "ok" | "error";
  sessionId?: string;
  exitCode?: number | null;
  error?: string;
  output?: string;
}
