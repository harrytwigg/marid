import { ApiError, get } from "@/lib/api"

/**
 * The Auto-Dispatch page's reads: the board walk's status and tick log, the
 * sessions started per engine (from the session registry, whatever started
 * them) and the retained Claude usage samples. A leaf beside `api.ts`, which is
 * at its size budget, in the shape `api-config.ts` set.
 *
 * The types mirror the gateway's (`board-walk/settings.ts`, `board-walk/store.ts`,
 * `board-walk/started-sessions.ts`, `shared/claude-usage-history.ts`); nothing
 * runtime crosses from that package into the bundle, so they are spelled here
 * as every other wire type is. Nothing here writes: the board walk's rules are
 * prose in `board-walk.md`, edited as a file.
 */

export interface UsageSampleWindow {
  name: string
  usedPercent: number
  /** Unix seconds — the window's identity. */
  resetsAt: number
}

export interface UsageSample {
  /** Epoch ms of the reading. */
  at: number
  windows: UsageSampleWindow[]
}

export type StartedBy = "board-walk-dispatch" | "board-walk" | "dispatch" | "capture" | "cron" | "delegated" | "chat"

export interface StartedSession {
  id: string
  engine: string
  model: string | null
  employee: string | null
  title: string | null
  source: string
  status: string
  createdAt: string
  startedBy: StartedBy
}

export type BoardWalkAction = "release" | "park" | "flagStuck" | "dispatch" | "comment"

export interface BoardWalkSettings {
  enabled: boolean
  schedule: string
  timezone: string
  employee: string
  model?: string
  actions: Record<BoardWalkAction, boolean>
}

export interface TickEntry {
  kind: string
  workItemId?: string
  reason: string
  outcome?: string
  sessionId?: string
}

export interface TickRecord {
  at: string
  trigger: "schedule" | "manual"
  outcome: "ok" | "disabled" | "invalid-rules" | "failed" | "busy"
  summary: string
  sessionId?: string
  durationMs?: number
  entries: TickEntry[]
}

export interface BoardWalkStatus {
  path: string
  exists: boolean
  settings: BoardWalkSettings
  problems: string[]
  scheduled: boolean
  running: boolean
  lastTick?: TickRecord
}

export function getBoardWalkStatus(init?: RequestInit): Promise<BoardWalkStatus> {
  return get<BoardWalkStatus>("/api/board-walk", init)
}

export async function getBoardWalkTicks(limit = 20, init?: RequestInit): Promise<TickRecord[]> {
  return (await get<{ ticks: TickRecord[] }>(`/api/board-walk/ticks?limit=${limit}`, init)).ticks
}

export async function getStartedSessions(hours = 168, init?: RequestInit): Promise<StartedSession[]> {
  return (await get<{ sessions: StartedSession[] }>(`/api/auto-dispatch/sessions?hours=${hours}`, init)).sessions
}

export async function getUsageSamples(hours = 168, init?: RequestInit): Promise<UsageSample[]> {
  return (await get<{ samples: UsageSample[] }>(`/api/auto-dispatch/usage?hours=${hours}`, init)).samples
}

/** Whether a failed status read means "no board walk in this gateway" (503),
 *  which the page reports as a state rather than an error. */
export function isWalkAbsent(error: unknown): boolean {
  return error instanceof ApiError && error.status === 503
}

export const STARTED_BY_LABEL: Record<StartedBy, string> = {
  "board-walk-dispatch": "board walk",
  "board-walk": "board walk's own turn",
  dispatch: "dispatch button",
  capture: "quick capture",
  cron: "cron",
  delegated: "delegated",
  chat: "chat",
}
