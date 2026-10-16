import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { SubagentTranscriptView } from '@/components/chat/subagent-transcript-view'
import { formatElapsed } from '@/lib/session-waits'
import {
  SUBAGENT_LIVE_MS,
  getSubagentTranscript,
  subagentRefetchMs,
  subagentUnavailableText,
  type SubagentRef,
  type SubagentTranscriptResponse,
} from '@/lib/subagent-transcript'

const NOTE = 'm-0 px-4 py-8 text-center text-[length:var(--text-caption1)] text-[var(--text-secondary)]'

const stop = (event: { stopPropagation: () => void }) => event.stopPropagation()
/** A dialog's events travel through React's tree to the chat pane it was opened from, whose click, key,
 *  focus-tracking and file-drop handlers have no business with a read-only view. A drop is also
 *  cancelled here, or the browser would open the file in place of the page. */
const ISOLATED = {
  onClick: stop,
  onPointerDown: stop,
  onMouseDown: stop,
  onKeyDown: stop,
  onDragEnter: stop,
  onDragLeave: stop,
  onDragOver: (event: React.DragEvent) => { event.preventDefault(); event.stopPropagation() },
  onDrop: (event: React.DragEvent) => { event.preventDefault(); event.stopPropagation() },
}

function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [])
  return now
}

function Activity({ data, now }: { data: SubagentTranscriptResponse | undefined; now: number }) {
  if (!data?.available) return null
  const quiet = now - Date.parse(data.updatedAt)
  const live = quiet < SUBAGENT_LIVE_MS
  return (
    <span data-testid="subagent-activity" data-live={live} className="flex shrink-0 items-center gap-1.5 text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
      <span
        aria-hidden="true"
        className={live ? 'h-1.5 w-1.5 rounded-full bg-[var(--system-orange)] animate-[jinn-pulse_1.4s_infinite] motion-reduce:animate-none' : 'h-1.5 w-1.5 rounded-full bg-[var(--text-tertiary)]'}
      />
      {live ? 'Working' : `Quiet for ${formatElapsed(quiet)}`}
    </span>
  )
}

function Body({ data, isError }: { data: SubagentTranscriptResponse | undefined; isError: boolean }) {
  if (data?.available) return <SubagentTranscriptView entries={data.entries} truncated={data.truncated} />
  if (data) return <p data-testid="subagent-unavailable" className={NOTE}><strong className="block pb-1 text-[var(--text-primary)]">Transcript not available</strong>{subagentUnavailableText(data.reason)}</p>
  return <p className={NOTE}>{isError ? 'Could not load this sub-agent’s transcript.' : 'Loading…'}</p>
}

/**
 * A background sub-agent's conversation in a dialog over the chat: read-only, and live while the
 * sub-agent writes. It is a dialog, not a route, so closing it leaves the chat exactly as it was.
 */
export default function SubagentTranscriptDialog({ sessionId, agent, returnFocusTo = null, onClose }: {
  sessionId: string
  agent: SubagentRef
  /** Takes focus when the view closes, if it is still on the page. */
  returnFocusTo?: HTMLElement | null
  onClose: () => void
}) {
  const now = useNow()
  const { data, isError } = useQuery({
    queryKey: queryKeys.subagentTranscript(sessionId, agent.id),
    queryFn: ({ signal }) => getSubagentTranscript(sessionId, agent.id, signal),
    refetchInterval: (query) => subagentRefetchMs(query.state.data, Date.now()),
    staleTime: 0,
    gcTime: 0,
  })
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent
        data-testid="subagent-transcript-dialog"
        data-pane-focus-preserving
        {...ISOLATED}
        onCloseAutoFocus={(event) => {
          // Radix would return focus to the popup row that opened this, which is gone.
          if (!returnFocusTo?.isConnected) return
          event.preventDefault()
          returnFocusTo.focus()
        }}
        className="flex h-[min(80vh,720px)] w-[min(720px,calc(100vw-16px))] max-w-none flex-col gap-0 rounded-[var(--radius-xl)] border-0 bg-[var(--bg-secondary)] p-0 shadow-[var(--shadow-overlay)] sm:max-w-none"
      >
        <header className="flex shrink-0 items-start gap-3 px-4 pb-2 pt-3 pr-11">
          <div className="min-w-0 flex-1">
            <DialogTitle className="m-0 truncate text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
              {agent.description ?? 'Sub-agent'}
            </DialogTitle>
            <DialogDescription className="m-0 truncate text-[length:var(--text-caption1)] text-[var(--text-secondary)]">
              {['Sub-agent', agent.agentType, 'read-only'].filter(Boolean).join(' · ')}
            </DialogDescription>
          </div>
          <Activity data={data} now={now} />
        </header>
        <Body data={data} isError={isError} />
      </DialogContent>
    </Dialog>
  )
}
