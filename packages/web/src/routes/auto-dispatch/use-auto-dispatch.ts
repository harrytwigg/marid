import { usePolledRead, type PolledReadState } from "@/hooks/use-polled-read"
import {
  getBoardWalkStatus,
  getBoardWalkTicks,
  getStartedSessions,
  getUsageSamples,
  isWalkAbsent,
  type BoardWalkStatus,
  type StartedSession,
  type TickRecord,
  type UsageSample,
} from "@/lib/api-auto-dispatch"

/** Status, tick log and session re-read cadence while visible — the Limits page's. */
export const LIVE_REFRESH_INTERVAL_MS = 60_000
/** Usage samples are collapsed to one per five minutes on the gateway, so
 *  asking more often than that can never show anything new. */
export const USAGE_REFRESH_INTERVAL_MS = 5 * 60_000
export const REQUEST_TIMEOUT_MS = 8_000
export const TICK_MS = 30_000

export interface AutoDispatchLive {
  /** Null when the gateway runs no board walk (a 503), which is a state, not an error. */
  status: BoardWalkStatus | null
  walkAbsent: boolean
  ticks: TickRecord[]
  sessions: StartedSession[]
}

async function readLive(signal: AbortSignal): Promise<AutoDispatchLive> {
  const [status, ticks, sessions] = await Promise.all([
    getBoardWalkStatus({ signal }).then(
      (value) => ({ value, absent: false }),
      (error: unknown) => {
        if (isWalkAbsent(error)) return { value: null, absent: true }
        throw error
      },
    ),
    getBoardWalkTicks(10, { signal }),
    getStartedSessions(168, { signal }),
  ])
  return { status: status.value, walkAbsent: status.absent, ticks, sessions }
}

export function useAutoDispatchLive(): PolledReadState<AutoDispatchLive> {
  return usePolledRead<AutoDispatchLive>({
    fetch: readLive,
    intervalMs: LIVE_REFRESH_INTERVAL_MS,
    timeoutMs: REQUEST_TIMEOUT_MS,
    tickMs: TICK_MS,
    timeoutMessage: "Timed out reading the board walk.",
    failureMessage: "Failed to read the board walk",
  })
}

export function useUsageSamples(): PolledReadState<UsageSample[]> {
  return usePolledRead<UsageSample[]>({
    fetch: (signal) => getUsageSamples(168, { signal }),
    intervalMs: USAGE_REFRESH_INTERVAL_MS,
    timeoutMs: REQUEST_TIMEOUT_MS,
    tickMs: TICK_MS,
    timeoutMessage: "Timed out reading usage history.",
    failureMessage: "Failed to read usage history",
  })
}
