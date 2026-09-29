import { ApiError, get } from "@/lib/api"
import { CONFIG_REVISION_HEADER } from "@/lib/api-config"
import { authFetch } from "@/lib/auth"

/**
 * The Auto-Dispatch page's reads: the idle-capacity auto-start's
 * preview, policy, history and usage samples. A leaf beside `api.ts`, which is
 * at its size budget, in the shape `api-config.ts` set.
 *
 * The types mirror the gateway's (`shared/idle-capacity-config.ts`,
 * `gateway/idle-capacity.ts`, `shared/idle-capacity-record.ts`,
 * `shared/claude-usage-history.ts`); nothing runtime crosses from that package
 * into the bundle, so they are spelled here as every other wire type is.
 */

export type IdleCapacityTier = "overnight" | "daytime" | "interactive"

export interface IdleCapacityWindowPolicy {
  maxUsedPercent: number
  lookaheadMinutes: number
}

export interface IdleCapacityTierPolicy {
  enabled: boolean
  fiveHour: IdleCapacityWindowPolicy
  sevenDay: IdleCapacityWindowPolicy
  maxDispatchesPerWindow: number
  maxActiveSessions: number
}

/** `gateway.idleCapacity` with every key explicit, as the loop resolves it. */
export interface IdleCapacityPolicy {
  enabled: boolean
  intervalMinutes: number
  timezone: string
  quietHours: { start: string; end: string }
  operatorActivity: { idleMinutes: number; usageDeltaPercent: number }
  tiers: Record<IdleCapacityTier, IdleCapacityTierPolicy>
  requireLabel: string | null
}

export const IDLE_CAPACITY_TIERS: readonly IdleCapacityTier[] = ["overnight", "daytime", "interactive"]

export interface IdleCapacityWindowReading {
  name: string
  usedPercent: number
  /** Unix seconds. */
  resetsAt: number
  minutesToReset: number
}

export interface IdleCapacityVerdict {
  act: boolean
  tier: IdleCapacityTier
  trigger?: "5h" | "7d"
  reason: string
  fiveHour?: IdleCapacityWindowReading
  weekly: IdleCapacityWindowReading[]
}

export interface IdleCapacityPreview {
  policy: IdleCapacityPolicy
  tier: IdleCapacityTier
  reason: string
  verdict?: IdleCapacityVerdict
  skipped: Array<{ workItemId: string; reason: string }>
  eligible: Array<{ workItemId: string; title: string; priority: number }>
  startedThisWindow: number
  operator: { live: boolean; seenAt?: number; source?: string }
  quietHours: boolean
}

/** One auto-start, as the loop's own comment recorded it (fields the comment
 *  could not be parsed for are absent and `partial` is set). */
export interface IdleCapacityStart {
  workItemId: string
  commentId: string
  startedAt: string
  title: string
  status: string
  partial: boolean
  tier?: IdleCapacityTier
  trigger?: "5h" | "7d"
  fiveHour?: { name: string; usedPercent: number; minutesToReset: number }
  weekly: Array<{ name: string; usedPercent: number; minutesToReset: number }>
  sessionId?: string
  charged?: number
  cap?: number
}

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

export interface IdleCapacityPolicyDocument {
  policy: IdleCapacityPolicy
  /** The raw block config.yaml holds, or null when it holds none. */
  configured: Record<string, unknown> | null
  /** Hand it to `updateConfig` so a save over a changed file is refused. */
  revision: string
}

export function getIdleCapacityPreview(init?: RequestInit): Promise<IdleCapacityPreview> {
  return get<IdleCapacityPreview>("/api/idle-capacity", init)
}

export async function getIdleCapacityPolicy(): Promise<IdleCapacityPolicyDocument> {
  const res = await authFetch("/api/idle-capacity/policy")
  if (!res.ok) throw new ApiError(res.status, `API error: ${res.status}`)
  const body = (await res.json()) as Omit<IdleCapacityPolicyDocument, "revision">
  return { ...body, revision: res.headers.get(CONFIG_REVISION_HEADER) ?? "" }
}

export async function getIdleCapacityHistory(limit = 50, init?: RequestInit): Promise<IdleCapacityStart[]> {
  return (await get<{ starts: IdleCapacityStart[] }>(`/api/idle-capacity/history?limit=${limit}`, init)).starts
}

export async function getIdleCapacityUsage(hours = 168, init?: RequestInit): Promise<UsageSample[]> {
  return (await get<{ samples: UsageSample[] }>(`/api/idle-capacity/usage?hours=${hours}`, init)).samples
}

/** Whether a failed preview means "no loop in this gateway" (503), which the
 *  page reports as a state rather than an error. */
export function isLoopAbsent(error: unknown): boolean {
  return error instanceof ApiError && error.status === 503
}
