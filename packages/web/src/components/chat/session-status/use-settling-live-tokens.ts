import { useEffect, useState } from 'react'

/** The longest the streamed figure is kept after its turn, should no refetch land. */
export const SETTLE_HOLD_MS = 10_000

const positive = (n: number | null | undefined): number | null => (n != null && n > 0 ? n : null)

/**
 * When the current turn ended (ms), or null while one runs or once released.
 * Derived during render, so the frame the turn ends in already holds.
 */
function useTurnEnd(loading: boolean, onTurnStart: () => void) {
  const [prevLoading, setPrevLoading] = useState(loading)
  const [endedAt, setEndedAt] = useState<number | null>(null)
  if (prevLoading !== loading) {
    setPrevLoading(loading)
    setEndedAt(loading ? null : Date.now())
    if (loading) onTurnStart()
  }
  return [endedAt, setEndedAt] as const
}

/**
 * The streamed context figure to overlay on the fetched one. While a turn runs
 * it is the live value. When the turn ends, the fetched figure is still the
 * pre-turn size until the refetch the settle triggers has landed, so the turn's
 * last streamed value is kept until the usage query has data newer than the
 * turn's end (or {@link SETTLE_HOLD_MS} passes). The pane clears its live value
 * in the same render that ends the turn, so the last one is remembered here
 * rather than read from the prop. After that the fetched size wins, which is
 * what a compaction needs: its post size (or null) replaces the streamed
 * pre-compaction figure.
 */
export function useSettlingLiveTokens(
  loading: boolean,
  live: number | null | undefined,
  /** `dataUpdatedAt` of the context-usage query. */
  updatedAt: number,
): number | null {
  const [lastLive, setLastLive] = useState<number | null>(null)
  const [endedAt, setEndedAt] = useTurnEnd(loading, () => setLastLive(null))
  const streamed = loading ? positive(live) : null
  if (streamed !== null && streamed !== lastLive) setLastLive(streamed)
  const holding = !loading && endedAt !== null && updatedAt <= endedAt
  useEffect(() => {
    if (!holding) return
    const timer = setTimeout(() => setEndedAt(null), SETTLE_HOLD_MS)
    return () => clearTimeout(timer)
  }, [holding, setEndedAt])
  if (loading) return live ?? null
  return holding ? lastLive : null
}
