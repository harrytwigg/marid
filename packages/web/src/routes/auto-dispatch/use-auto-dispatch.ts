import { useCallback, useEffect, useState } from "react"
import { usePolledRead, type PolledReadState } from "@/hooks/use-polled-read"
import {
  getIdleCapacityHistory,
  getIdleCapacityPolicy,
  getIdleCapacityPreview,
  getIdleCapacityUsage,
  isLoopAbsent,
  type IdleCapacityPolicyDocument,
  type IdleCapacityPreview,
  type IdleCapacityStart,
  type UsageSample,
} from "@/lib/api-idle-capacity"

/** Preview and history re-read cadence while visible — the Limits page's. */
export const LIVE_REFRESH_INTERVAL_MS = 60_000
/** Usage samples are collapsed to one per five minutes on the gateway, so
 *  asking more often than that can never show anything new. */
export const USAGE_REFRESH_INTERVAL_MS = 5 * 60_000
export const REQUEST_TIMEOUT_MS = 8_000
export const TICK_MS = 30_000

export interface AutoDispatchLive {
  /** Null when the gateway runs no loop (a 503), which is a state, not an error. */
  preview: IdleCapacityPreview | null
  loopAbsent: boolean
  history: IdleCapacityStart[]
}

async function readLive(signal: AbortSignal): Promise<AutoDispatchLive> {
  const [preview, history] = await Promise.all([
    getIdleCapacityPreview({ signal }).then(
      (value) => ({ value, absent: false }),
      (error: unknown) => {
        if (isLoopAbsent(error)) return { value: null, absent: true }
        throw error
      },
    ),
    getIdleCapacityHistory(50, { signal }),
  ])
  return { preview: preview.value, loopAbsent: preview.absent, history }
}

export interface PolicyDocumentState {
  document: IdleCapacityPolicyDocument | null
  error: string | null
  /** Re-read the policy and its revision. On mount and on Reload only — never
   *  after a save, because adopting a revision drops any queued edit. */
  reload: () => Promise<IdleCapacityPolicyDocument | null>
}

/** The policy block and the revision it was read under, from one response. */
export function usePolicyDocument(): PolicyDocumentState {
  const [document, setDocument] = useState<IdleCapacityPolicyDocument | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(async () => {
    try {
      const next = await getIdleCapacityPolicy()
      setDocument(next)
      setError(null)
      return next
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the idle-capacity policy")
      return null
    }
  }, [])
  useEffect(() => {
    void reload()
  }, [reload])
  return { document, error, reload }
}

export function useAutoDispatchLive(): PolledReadState<AutoDispatchLive> {
  return usePolledRead<AutoDispatchLive>({
    fetch: readLive,
    intervalMs: LIVE_REFRESH_INTERVAL_MS,
    timeoutMs: REQUEST_TIMEOUT_MS,
    tickMs: TICK_MS,
    timeoutMessage: "Timed out reading the idle-capacity loop.",
    failureMessage: "Failed to read the idle-capacity loop",
  })
}

export function useUsageSamples(): PolledReadState<UsageSample[]> {
  return usePolledRead<UsageSample[]>({
    fetch: (signal) => getIdleCapacityUsage(168, { signal }),
    intervalMs: USAGE_REFRESH_INTERVAL_MS,
    timeoutMs: REQUEST_TIMEOUT_MS,
    tickMs: TICK_MS,
    timeoutMessage: "Timed out reading usage history.",
    failureMessage: "Failed to read usage history",
  })
}
