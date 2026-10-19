import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useOpenSubagentTab } from '@/components/chat/file-open-context'
import { SessionWaitsBoundary, WaitsNote } from '@/components/chat/session-waits-boundary'
import type { SubagentRef } from '@/lib/subagent-transcript'

/** A sub-agent's conversation is its own chunk, read only once a row of the waiting-on popup opens it. */
const SubagentTranscriptDialog = lazy(() => import('@/components/chat/subagent-transcript-dialog'))

/**
 * The sub-agent view of one chat: `open` shows a sub-agent's conversation, and `node` is where a sheet
 * over the chat renders. The layout shows it as a tab beside the chat where it can (desktop); the sheet
 * is for where it cannot (a phone). The chat owns the sheet, not the status line that opens it: the
 * status goes when the sub-agent is done, or while a turn streams, and the sheet stays until the reader
 * closes it. It is closed when the chat shows another session.
 */
export function useSubagentView(sessionId: string | null): {
  /** `returnFocusTo` is where focus goes when the view closes: the popup row that opened it is gone by then. */
  open: (agent: SubagentRef, returnFocusTo?: HTMLElement | null) => void
  node: ReactNode
} {
  const openTab = useOpenSubagentTab()
  const [shown, setShown] = useState<{ sessionId: string; agent: SubagentRef; returnFocusTo: HTMLElement | null } | null>(null)
  const open = useCallback((agent: SubagentRef, returnFocusTo: HTMLElement | null = null) => {
    if (!sessionId) return
    if (openTab?.({ sessionId, agentId: agent.id, description: agent.description, agentType: agent.agentType })) return
    setShown({ sessionId, agent, returnFocusTo })
  }, [sessionId, openTab])
  const close = useCallback(() => setShown(null), [])
  // Another session's chat is not this one's view, and coming back to this one must not bring it back.
  useEffect(() => setShown(null), [sessionId])
  const node = useMemo(() => {
    if (!shown || shown.sessionId !== sessionId) return null
    return (
      <SessionWaitsBoundary failure={<WaitsNote>Could not load the sub-agent view.</WaitsNote>}>
        <Suspense fallback={null}>
          <SubagentTranscriptDialog key={shown.agent.id} sessionId={shown.sessionId} agent={shown.agent} returnFocusTo={shown.returnFocusTo} onClose={close} />
        </Suspense>
      </SessionWaitsBoundary>
    )
  }, [shown, sessionId, close])
  return { open, node }
}
