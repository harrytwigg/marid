import { useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'
import { contextUsageApi, type ContextUsageWire } from '@/lib/api-context-usage'

export interface ContextUsageSignals {
  /** The session's reported status; a change means the turn moved on. */
  status?: string | null
  /** The session's last context size; a change means a turn settled. */
  lastContextTokens?: number | null
  /** Poll while a compaction is in flight, when no event may say it ended. */
  pollMs?: number | false
}

/**
 * `GET /api/sessions/:id/context-usage`, one cache entry per session. The
 * gateway also reports whether a manual compact is allowed right now, so the
 * answer goes stale the moment the session's status or size changes: those two
 * signals refetch it. Session-detail invalidations refetch it too (the key sits
 * under the detail key).
 */
export function useSessionContextUsage(
  sessionId: string | null | undefined,
  { status, lastContextTokens, pollMs = false }: ContextUsageSignals = {},
) {
  const query = useQuery<ContextUsageWire>({
    queryKey: queryKeys.sessions.contextUsage(sessionId ?? ''),
    queryFn: () => contextUsageApi.getContextUsage(sessionId as string),
    enabled: !!sessionId,
    staleTime: 10_000,
    refetchInterval: pollMs,
    retry: false,
  })
  const { refetch } = query
  const seen = useRef({ sessionId, status, lastContextTokens })
  useEffect(() => {
    const prev = seen.current
    seen.current = { sessionId, status, lastContextTokens }
    if (!sessionId || prev.sessionId !== sessionId) return
    if (prev.status !== status || prev.lastContextTokens !== lastContextTokens) void refetch()
  }, [sessionId, status, lastContextTokens, refetch])
  return query
}
