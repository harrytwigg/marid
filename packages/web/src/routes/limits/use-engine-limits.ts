import { api } from "@/lib/api"
import type { EngineLimitEngineSnapshot, EngineLimitsResponse } from "@/lib/api"
import { usePolledRead, type PolledReadState } from "@/hooks/use-polled-read"

/** Re-fetch cadence while the tab is visible. Bounded (one timer) and paused
 *  when hidden so a backgrounded dashboard never storms the gateway. */
export const LIMITS_REFRESH_INTERVAL_MS = 60_000
/** How long a captured snapshot may be presented as current before it is
 *  labelled stale. Mirrors the collector's own 30-minute staleness threshold. */
export const LIMITS_FRESHNESS_MS = 30 * 60_000
/** Abort a single refresh after this long so a hung request can never wedge the
 *  in-flight guard and discard every subsequent trigger. */
export const LIMITS_REQUEST_TIMEOUT_MS = 8_000
/** Display-clock cadence: advances the freshness labels/states while the page
 *  stays open, independent of whether a fetch ever completes. */
export const LIMITS_TICK_MS = 30_000

export type FreshnessKind =
  | "live"
  | "fresh"
  | "stale"
  | "error"
  | "unavailable"
  | "unsupported"
  | "nodata"
export interface FreshnessView {
  kind: FreshnessKind
  /** Age of the last-known snapshot at evaluation time, when one exists. */
  ageMs?: number
}

function classifyAge(ageMs: number): FreshnessView {
  return ageMs > LIMITS_FRESHNESS_MS ? { kind: "stale", ageMs } : { kind: "fresh", ageMs }
}

function hasObservedWindows(engine: EngineLimitEngineSnapshot | undefined): boolean {
  return engine?.windows?.some((w) => w.usedPercent !== undefined) ?? false
}

/**
 * Classify an engine's freshness at *display* time, from its captured-at
 * timestamp against `nowMs` — never from the server's `stale` boolean, which
 * freezes the instant the response is fetched and would otherwise let a
 * long-open tab keep presenting hours-old data as current.
 */
export function deriveFreshness(engine: EngineLimitEngineSnapshot, nowMs: number): FreshnessView {
  const hasObserved = hasObservedWindows(engine)
  // Retained last-known windows annotated with a current refresh failure (see
  // mergeAuthoritative): never fresh — surface as stale-last-known with its
  // real age so the current error can sit beside honest data.
  if (hasObserved && engine.error) {
    const t = engine.refreshedAt ? Date.parse(engine.refreshedAt) : NaN
    return { kind: "stale", ageMs: Number.isFinite(t) ? Math.max(0, nowMs - t) : undefined }
  }
  if (engine.status === "error") return { kind: "error" }
  if (engine.status === "unavailable") return { kind: "unavailable" }
  if (engine.status === "unsupported") return { kind: "unsupported" }
  if (engine.status === "live") return { kind: "live" }

  const t = engine.refreshedAt ? Date.parse(engine.refreshedAt) : NaN
  if (!Number.isFinite(t)) {
    return hasObserved ? { kind: "stale" } : { kind: "nodata" }
  }
  const ageMs = Math.max(0, nowMs - t)
  // `static` = capability-only (no observed usage window) → not a freshness claim.
  if (engine.status === "static" && !hasObserved) return { kind: "nodata", ageMs }
  return classifyAge(ageMs)
}

// Fixed, allowlisted phrase per degraded status — derived only from the status
// enum, never from the server's (possibly raw) error/reason text.
function degradedClause(status: EngineLimitEngineSnapshot["status"]): string {
  switch (status) {
    case "error":
      return "the latest snapshot was unreadable"
    case "unavailable":
      return "the engine is unavailable"
    case "unsupported":
      return "live limits aren’t available"
    default:
      return "the latest refresh failed"
  }
}

/**
 * Merge a fresh response over the last-known one, per engine. When the new
 * snapshot for an engine lacks usable windows (a degraded error/unavailable/
 * unsupported response arriving as HTTP 200) but the previous one had
 * authoritative windows, retain those windows AND their original captured-at
 * timestamp, and attach the current degradation as an error so the UI shows
 * honest stale last-known data beside the live failure. Never overwrites good
 * data with an empty snapshot.
 */
export function mergeAuthoritative(
  prev: EngineLimitsResponse | null,
  next: EngineLimitsResponse,
): EngineLimitsResponse {
  if (!prev) return next
  const engines: Record<string, EngineLimitEngineSnapshot> = { ...next.engines }
  for (const [name, ne] of Object.entries(next.engines)) {
    if (hasObservedWindows(ne)) continue
    const pe = prev.engines[name]
    if (pe && hasObservedWindows(pe)) {
      engines[name] = {
        ...pe, // keep authoritative windows + original refreshedAt/status/plan
        error: `Couldn’t refresh — showing last-known values (${degradedClause(ne.status)}).`,
      }
    }
  }
  return { ...next, engines }
}

export type EngineLimitsState = PolledReadState<EngineLimitsResponse>

/**
 * Owns the Limits page's refresh policy — the shared polled read (initial load,
 * expiry-while-visible, visibility-return, reconnect, one in-flight guard, an
 * abort-bounded request, last-known data kept on failure, a display clock) —
 * plus the one rule that is this page's own: a degraded refresh merges over the
 * last-known authoritative windows rather than replacing them.
 */
export function useEngineLimits(): EngineLimitsState {
  return usePolledRead<EngineLimitsResponse>({
    fetch: (signal) => api.getEngineLimits(undefined, { signal }),
    merge: mergeAuthoritative,
    intervalMs: LIMITS_REFRESH_INTERVAL_MS,
    timeoutMs: LIMITS_REQUEST_TIMEOUT_MS,
    tickMs: LIMITS_TICK_MS,
    timeoutMessage: "Timed out refreshing engine limits.",
    failureMessage: "Failed to load engine limits",
  })
}
