import { useCallback, useEffect, useRef, useState } from "react"
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
  type UsageAccountOption,
  type UsageResponse,
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

/** The Claude account whose history the usage card shows when none is picked. */
export const DEFAULT_ACCOUNT = "claude"

export interface UsageRead extends PolledReadState<UsageSample[]> {
  /** Every Claude account, default first; empty with a single one. */
  accounts: UsageAccountOption[]
  /** The account on show: the one picked, else the default. */
  account: string
  select: (account: string) => void
}

/** A response, remembered with the account it was asked for, so a late answer
 *  for an account since switched away from is never shown as the current one. */
interface TaggedUsage extends UsageResponse {
  requested: string
}

export function useUsageSamples(): UsageRead {
  const [picked, setPicked] = useState(DEFAULT_ACCOUNT)
  const read = usePolledRead<TaggedUsage>({
    // The default account is the gateway's own default, so it is asked for bare.
    fetch: async (signal) => ({
      ...(await getUsageSamples(168, picked === DEFAULT_ACCOUNT ? undefined : picked, { signal })),
      requested: picked,
    }),
    intervalMs: USAGE_REFRESH_INTERVAL_MS,
    timeoutMs: REQUEST_TIMEOUT_MS,
    tickMs: TICK_MS,
    timeoutMessage: "Timed out reading usage history.",
    failureMessage: "Failed to read usage history",
  })
  const accounts = read.data?.accounts ?? []
  const account = accounts.some((option) => option.account === picked) ? picked : DEFAULT_ACCOUNT

  // A switch reads the new account at once. If a read is already in flight it is
  // dropped by the in-flight guard, so one retry follows when that read lands.
  const retried = useRef(DEFAULT_ACCOUNT)
  useEffect(() => {
    if (read.refreshing || !read.data || read.data.requested === account || retried.current === account) return
    retried.current = account
    read.refresh()
  }, [account, read, read.refreshing, read.data])
  const select = useCallback((next: string) => setPicked(next), [])

  const current = read.data?.requested === account ? read.data : null
  return { ...read, data: current?.samples ?? null, accounts, account, select }
}
