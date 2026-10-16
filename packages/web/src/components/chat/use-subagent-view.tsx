import { lazy, Suspense, useCallback, useMemo, useState, type ReactNode } from 'react'
import { SessionWaitsBoundary, WaitsNote } from '@/components/chat/session-waits-boundary'
import type { SubagentRef } from '@/lib/subagent-transcript'

/** A sub-agent's conversation is its own chunk, read only once a row of the waiting-on popup opens it. */
const SubagentTranscriptDialog = lazy(() => import('@/components/chat/subagent-transcript-dialog'))

/**
 * The sub-agent view of one chat: `open` shows a sub-agent's conversation over the chat, and `node`
 * is where it renders. The chat owns it, not the status line that opens it: the status goes when the
 * sub-agent is done, or while a turn streams, and the view stays until the reader closes it. It is
 * closed when the chat shows another session.
 */
export function useSubagentView(sessionId: string | null): { open: (agent: SubagentRef) => void; node: ReactNode } {
  const [shown, setShown] = useState<{ sessionId: string; agent: SubagentRef } | null>(null)
  const open = useCallback((agent: SubagentRef) => { if (sessionId) setShown({ sessionId, agent }) }, [sessionId])
  const close = useCallback(() => setShown(null), [])
  const node = useMemo(() => {
    if (!shown || shown.sessionId !== sessionId) return null
    return (
      <SessionWaitsBoundary failure={<WaitsNote>Could not load the sub-agent view.</WaitsNote>}>
        <Suspense fallback={null}>
          <SubagentTranscriptDialog key={shown.agent.id} sessionId={shown.sessionId} agent={shown.agent} onClose={close} />
        </Suspense>
      </SessionWaitsBoundary>
    )
  }, [shown, sessionId, close])
  return { open, node }
}
