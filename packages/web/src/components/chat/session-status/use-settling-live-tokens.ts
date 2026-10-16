import { useEffect, useState } from 'react'

/** The longest the streamed figure is kept after its turn, should no refetch land. */
export const SETTLE_HOLD_MS = 10_000

/**
 * The streamed context figure to overlay on the fetched one. While a turn runs
 * it is the live value. When the turn ends, the fetched figure is still the
 * pre-turn size until the refetch the settle triggers has landed, so the live
 * value is kept until the usage query has data newer than the turn's end (or
 * {@link SETTLE_HOLD_MS} passes). After that the fetched size wins, which is
 * what a compaction needs: its post size (or null) replaces the streamed
 * pre-compaction figure.
 */
export function useSettlingLiveTokens(
  loading: boolean,
  live: number | null | undefined,
  /** `dataUpdatedAt` of the context-usage query. */
  updatedAt: number,
): number | null {
  const [prevLoading, setPrevLoading] = useState(loading)
  const [endedAt, setEndedAt] = useState<number | null>(null)
  // Derived during render, so the frame the turn ends in already holds.
  if (prevLoading !== loading) {
    setPrevLoading(loading)
    setEndedAt(loading ? null : Date.now())
  }
  const holding = !loading && endedAt !== null && updatedAt <= endedAt
  useEffect(() => {
    if (!holding) return
    const timer = setTimeout(() => setEndedAt(null), SETTLE_HOLD_MS)
    return () => clearTimeout(timer)
  }, [holding])
  return loading || holding ? (live ?? null) : null
}
