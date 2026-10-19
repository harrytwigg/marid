import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'
import { contextUsageApi, type ContextUsageWire } from '@/lib/api-context-usage'
import { useSessionContextUsage } from '@/hooks/use-session-context-usage'
import { fmtK } from '@/lib/context-usage'
import { shownTokens } from './context-meter-model'
import { useSettlingLiveTokens } from './use-settling-live-tokens'

export type CompactPhase =
  | { kind: 'idle' }
  | { kind: 'compacting' }
  | { kind: 'done'; message: string }
  | { kind: 'error'; message: string }

const POLL_MS = 2500
/** If the compaction turn is never seen running, settle anyway after this long. */
const NEVER_SEEN_MS = 60_000

/** Refusal codes that mean the session is running something (the compaction turn included). */
const RUNNING_CODES = new Set(['busy', 'compacting'])

export const UNCONFIRMED_MESSAGE =
  "Compaction finished without a confirmed size change; see the chat for the engine's message"

/**
 * What a settled compaction says, judged from the refetched size and never from
 * the session merely going idle: a lower figure, or none where there was one,
 * means it compacted; anything else is reported neutrally (the chat carries the
 * engine's own confirmation or failure notice).
 */
export function compactOutcome(pre: number | null, post: number | null | undefined): string {
  if (pre == null) return post == null ? UNCONFIRMED_MESSAGE : `Compaction finished; the context is now ${fmtK(post)}`
  if (post == null) return 'Compacted; the size updates after the next turn'
  return post < pre ? `Compacted: ${fmtK(pre)} → ${fmtK(post)}` : UNCONFIRMED_MESSAGE
}

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'Could not start the compaction'
}

interface FlowInput {
  sessionId: string
  /** The pane's turn flag: true while any turn (the compaction included) runs. */
  loading: boolean
  status?: string | null
  lastContextTokens?: number | null
  liveContextTokens?: number | null
}

interface CompactRun {
  /** The size shown when the compaction was requested. */
  pre: number | null
  /** True once the compaction turn has been seen running. */
  sawActive: boolean
  settling: boolean
}

interface SettleInput {
  compacting: boolean
  /** A turn is running, or the gateway says the session is busy/compacting. */
  active: boolean
  /** The compaction is queued behind nothing yet started: the gateway reports it as "queued". */
  queued: boolean
  run: MutableRefObject<CompactRun>
  refetch: () => Promise<{ data?: ContextUsageWire }>
  setPhase: (phase: CompactPhase) => void
}

/**
 * Ends "Compacting…": once the compaction turn has been seen and the session is
 * idle again, read the fresh size and say what happened. A turn that is never
 * seen (a missed status event, a very fast compaction) settles after a grace
 * period, so the spinner cannot stay up.
 */
function useSettleWhenIdle({ compacting, active, queued, run, refetch, setPhase }: SettleInput) {
  const settle = useCallback(async () => {
    if (run.current.settling) return
    run.current.settling = true
    const fresh = (await refetch()).data
    setPhase({ kind: 'done', message: compactOutcome(run.current.pre, fresh?.contextTokens) })
  }, [run, refetch, setPhase])

  useEffect(() => {
    if (!compacting) return
    if (active) {
      run.current.sawActive = true
      return
    }
    // Queued, or not started yet: still waiting for the turn. Settle only after it has run.
    if (run.current.sawActive && !queued) void settle()
  }, [compacting, active, queued, run, settle])

  useEffect(() => {
    if (!compacting) return
    const timer = setTimeout(() => {
      if (!run.current.sawActive) void settle()
    }, NEVER_SEEN_MS)
    return () => clearTimeout(timer)
  }, [compacting, run, settle])
}

/**
 * The meter's data plus the manual-compact lifecycle: POST, "Compacting…" until
 * the compaction turn has run and the session is idle again, then one outcome
 * line. The usage query is polled while it waits, so a missed status event
 * cannot leave the spinner up.
 */
export function useCompactFlow({ sessionId, loading, status, lastContextTokens, liveContextTokens }: FlowInput) {
  const queryClient = useQueryClient()
  const [phase, setPhase] = useState<CompactPhase>({ kind: 'idle' })
  const compacting = phase.kind === 'compacting'
  const query = useSessionContextUsage(sessionId, {
    status,
    lastContextTokens,
    pollMs: compacting ? POLL_MS : false,
  })
  const data = query.data
  const run = useRef<CompactRun>({ pre: null, sawActive: false, settling: false })
  const live = useSettlingLiveTokens(loading, liveContextTokens, query.dataUpdatedAt)
  const shown = shownTokens(data, live)

  const start = useCallback(async () => {
    run.current = { pre: shown, sawActive: false, settling: false }
    setPhase({ kind: 'compacting' })
    const refresh = () => void queryClient.invalidateQueries({ queryKey: queryKeys.sessions.contextUsage(sessionId) })
    try {
      await contextUsageApi.compactSession(sessionId)
    } catch (err) {
      setPhase({ kind: 'error', message: errorMessage(err) })
    }
    refresh()
  }, [sessionId, shown, queryClient])

  const code = data?.compact.reason?.code
  useSettleWhenIdle({
    compacting,
    active: loading || status === 'running' || status === 'waiting' || (code != null && RUNNING_CODES.has(code)),
    queued: code === 'queued',
    run,
    refetch: query.refetch,
    setPhase,
  })

  const dismiss = useCallback(() => {
    setPhase((p) => (p.kind === 'done' || p.kind === 'error' ? { kind: 'idle' } : p))
  }, [])

  return { data, phase, start, dismiss, shown, live }
}
