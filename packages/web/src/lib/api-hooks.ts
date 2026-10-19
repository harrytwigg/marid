import { ApiError, get, post } from "@/lib/api"

/**
 * The Hooks page's reads and its one write: the configured board hooks, the
 * runs they have logged, and the `enabled` toggle. A leaf beside `api.ts`,
 * which is at its size budget, in the shape `api-auto-dispatch.ts` set.
 *
 * The types mirror the gateway's `board_hook_*` tables and the `hooks:` block
 * of `config.yaml`, as the API section of `docs/board-hooks.md` spells them;
 * nothing runtime crosses from the gateway package into the bundle. The page
 * can read a hook and flip `enabled`; a hook's events, matcher and actions are
 * config, edited as a file.
 */

/** One action of a hook, as `GET /api/hooks` summarises it. */
export type HookActionSummary =
  | { kind: "spawn"; employee: string }
  | { kind: "command"; run: string }
  | { kind: "notify"; connector: string; channel: string }

/** The matcher of a hook. Every field is optional, and a list is any-of; the
 *  fields AND together. Values are as written in `config.yaml`. */
export interface HookMatch {
  from?: string | string[]
  to?: string | string[]
  department?: string | string[]
  label?: string | string[]
  assignee?: string | string[]
  actor?: string | string[]
}

export type HookRunStatus = "running" | "ok" | "error" | "suppressed" | "interrupted"

/** The action a run row records; `none` is a suppressed fire. */
export type HookRunAction = "spawn" | "command" | "notify" | "none"

export interface BoardHook {
  name: string
  enabled: boolean
  events: string[]
  match: HookMatch
  actions: HookActionSummary[]
  allowReentry: boolean
  /** ISO timestamp of the hook's most recent run, or null if it has never fired. */
  lastFiredAt: string | null
  lastStatus: HookRunStatus | null
}

export interface HookRun {
  id: string
  fireId: string
  hook: string
  event: string
  eventId: string | null
  todoId: string | null
  action: HookRunAction
  status: HookRunStatus
  /** The session a `spawn` action started, when it started one. */
  sessionId: string | null
  /** The exit code of a `command`, when it ran. */
  exitCode: number | null
  error: string | null
  /** The config file's chain at fire time, oldest first. */
  chain: string[]
  startedAt: string
  finishedAt: string | null
  /** The fire payload — present only on the single-run read, omitted from list rows. */
  payload?: unknown
  /** A command's redacted output — present only on the single-run read. */
  output?: string | null
}

export interface HooksResponse {
  hooks: BoardHook[]
  /** Config the gateway could not parse; the hooks it does carry still run. */
  problems: string[]
}

export interface HookRunFilters {
  hook?: string
  status?: string
  todo?: string
  limit?: number
  /** A run id cursor: rows strictly older than it. */
  before?: string
}

export interface HookRunPage {
  runs: HookRun[]
  nextBefore: string | null
}

export function listHooks(init?: RequestInit): Promise<HooksResponse> {
  return get<HooksResponse>("/api/hooks", init)
}

export function listHookRuns(filters: HookRunFilters = {}, init?: RequestInit): Promise<HookRunPage> {
  const query = new URLSearchParams()
  if (filters.hook) query.set("hook", filters.hook)
  if (filters.status) query.set("status", filters.status)
  if (filters.todo) query.set("todo", filters.todo)
  if (filters.limit !== undefined) query.set("limit", String(filters.limit))
  if (filters.before) query.set("before", filters.before)
  const suffix = query.toString()
  return get<HookRunPage>(`/api/hooks/runs${suffix ? `?${suffix}` : ""}`, init)
}

export async function getHookRun(id: string, init?: RequestInit): Promise<HookRun> {
  return (await get<{ run: HookRun }>(`/api/hooks/runs/${encodeURIComponent(id)}`, init)).run
}

export function setHookEnabled(name: string, enabled: boolean): Promise<{ ok: true }> {
  return post<{ ok: true }>(`/api/hooks/${encodeURIComponent(name)}/enabled`, { enabled })
}

/** The five run statuses, in the order the outcome filter offers them. */
export const HOOK_RUN_STATUSES: readonly HookRunStatus[] = [
  "ok",
  "error",
  "running",
  "suppressed",
  "interrupted",
]

export function isHookRunStatus(value: string | null | undefined): value is HookRunStatus {
  return value != null && (HOOK_RUN_STATUSES as readonly string[]).includes(value)
}

/** A 403 from the toggle is the API's operator-only rule, not a bug. */
export function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403
}
