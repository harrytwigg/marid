import { useCallback, useEffect, useRef, useState } from "react"
import { useGateway } from "@/hooks/use-gateway"
import { usePageVisibility } from "@/hooks/use-page-visibility"

/**
 * One polled read of the gateway, with the refresh policy the Limits page
 * established and the Auto-Dispatch page then needed too: initial
 * load, expiry-while-visible, visibility-return and reconnect, all funnelled
 * through one in-flight guard so coincident triggers coalesce into a single
 * request; each request abort-bounded so a hung fetch can never wedge the
 * guard; a failed refresh keeps the last-known data and surfaces the error
 * beside it; and a display clock that advances while the page stays open,
 * independent of whether a fetch ever completes.
 *
 * What is NOT here is how a degraded response merges over the last-known one
 * — that is the caller's `merge`, because it is where the two pages differ.
 */

export interface PolledReadOptions<T> {
  /** The read. Honour the signal: the timeout aborts through it. */
  fetch: (signal: AbortSignal) => Promise<T>
  /** How a fresh response lands over the previous one. Default: replaces it. */
  merge?: (prev: T | null, next: T) => T
  /** Re-fetch cadence while the tab is visible. */
  intervalMs: number
  /** Abort a single request after this long. */
  timeoutMs: number
  /** Display-clock cadence. */
  tickMs: number
  /** What the error reads when the request is aborted by the timeout. */
  timeoutMessage: string
  /** What the error reads when the failure carries no message. */
  failureMessage: string
}

export interface PolledReadState<T> {
  data: T | null
  phase: "loading" | "ready"
  refreshing: boolean
  error: string | null
  /** Bounded display clock — pass to age/freshness helpers so they advance
   *  while the page stays open, independent of fetch completion. */
  now: number
  refresh: () => void
}

interface ReadSetters<T> {
  setData: (update: (prev: T | null) => T) => void
  setError: (error: string | null) => void
  setRefreshing: (value: boolean) => void
  setLoaded: (value: boolean) => void
}

/** One request: abort-bounded, and settled exactly once whichever side wins. */
function runRead<T>(options: PolledReadOptions<T>, inFlight: { current: boolean }, set: ReadSetters<T>): void {
  const { fetch, merge, timeoutMs, timeoutMessage, failureMessage } = options
  const controller = new AbortController()
  let settled = false
  const settle = () => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    inFlight.current = false
    set.setRefreshing(false)
    set.setLoaded(true)
  }
  const timer = setTimeout(() => {
    if (settled) return
    controller.abort()
    set.setError(timeoutMessage)
    settle()
  }, timeoutMs)

  fetch(controller.signal)
    .then((res) => {
      if (settled) return
      set.setData((prev) => (merge ? merge(prev, res) : res))
      set.setError(null)
    })
    .catch((err) => {
      if (settled || controller.signal.aborted) return // timeout path already handled
      set.setError(err instanceof Error ? err.message : failureMessage)
    })
    .finally(settle)
}

/** The triggers: initial load, expiry while visible, visibility return, reconnect. */
function useRefreshTriggers(refresh: () => void, visible: boolean, connectionSeq: number, intervalMs: number): void {
  useEffect(() => {
    refresh()
  }, [refresh])

  // Expiry: one bounded timer, live only while the tab is visible.
  useEffect(() => {
    if (!visible) return
    const id = setInterval(refresh, intervalMs)
    return () => clearInterval(id)
  }, [visible, refresh, intervalMs])

  // Visibility return: refresh when the tab comes back to the foreground.
  const prevVisible = useRef(visible)
  useEffect(() => {
    if (visible && !prevVisible.current) refresh()
    prevVisible.current = visible
  }, [visible, refresh])

  // Reconnect: refresh when the gateway socket re-opens (connectionSeq bumps).
  const prevSeq = useRef(connectionSeq)
  useEffect(() => {
    if (connectionSeq !== prevSeq.current) {
      prevSeq.current = connectionSeq
      refresh()
    }
  }, [connectionSeq, refresh])
}

/** Advances `now` while visible so age labels move forward on their own, even
 *  if a fetch hangs or the data never changes. */
function useDisplayClock(visible: boolean, tickMs: number): number {
  const [now, setNow] = useState<number>(() => Date.now())
  useEffect(() => {
    if (!visible) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), tickMs)
    return () => clearInterval(id)
  }, [visible, tickMs])
  return now
}

export function usePolledRead<T>(options: PolledReadOptions<T>): PolledReadState<T> {
  const { connectionSeq } = useGateway()
  const visible = usePageVisibility()
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const inFlight = useRef(false)
  // The latest options, so `refresh` stays referentially stable across renders
  // (its identity is what every trigger effect depends on).
  const latest = useRef(options)
  useEffect(() => { latest.current = options })

  const refresh = useCallback(() => {
    if (inFlight.current) return
    inFlight.current = true
    setRefreshing(true)
    runRead(latest.current, inFlight, { setData, setError, setRefreshing, setLoaded })
  }, [])

  useRefreshTriggers(refresh, visible, connectionSeq, options.intervalMs)
  const now = useDisplayClock(visible, options.tickMs)

  return { data, phase: loaded ? "ready" : "loading", refreshing, error, now, refresh }
}
