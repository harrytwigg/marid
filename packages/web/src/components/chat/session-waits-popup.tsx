import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { useOpenSession } from '@/components/chat/file-open-context'
import { WaitsNote } from '@/components/chat/session-waits-boundary'
import {
  BackgroundTaskRow,
  HeartbeatRow,
  RerunRow,
  SessionTree,
} from '@/components/chat/session-wait-rows'
import {
  retainGoneSessions,
  sectionWaits,
  type DelegatedSessionWait,
  type GoneSessionWait,
  type BackgroundTaskWait,
  type SessionNode,
  type SessionWaitItem,
} from '@/lib/session-waits'
import type { SubagentRef } from '@/lib/subagent-transcript'

/** A safety net for what no gateway event announces (a monitor's newest line). */
const REFRESH_MS = 15_000
const TICK_MS = 1_000
/** How long "Nothing pending" stays up before the popup closes itself. */
export const EMPTY_CLOSE_MS = 1_500

function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS)
    return () => window.clearInterval(timer)
  }, [])
  return now
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="py-1">
      <h3 className="m-0 px-2 pb-0.5 pt-1 text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-[0.04em] text-[var(--text-tertiary)]">
        {title}
      </h3>
      <ul className="m-0 list-none p-0">{children}</ul>
    </section>
  )
}

function OtherRow({ item, now, onOpenSubagent }: {
  item: Exclude<SessionWaitItem, DelegatedSessionWait>
  now: number
  onOpenSubagent?: (item: BackgroundTaskWait) => void
}) {
  if (item.kind === 'rerun') return <RerunRow item={item} now={now} />
  if (item.kind === 'heartbeat') return <HeartbeatRow item={item} now={now} />
  return <BackgroundTaskRow item={item} now={now} onOpenSubagent={onOpenSubagent} />
}

function Sections({ nodes, finished, others, now, onOpen, onOpenSubagent }: {
  nodes: SessionNode[]
  finished: SessionNode[]
  others: Exclude<SessionWaitItem, DelegatedSessionWait>[]
  now: number
  onOpen: (sessionId: string) => void
  onOpenSubagent?: (item: BackgroundTaskWait) => void
}) {
  return (
    <>
      {nodes.length || others.length ? (
        <Section title="Waiting on">
          <SessionTree nodes={nodes} now={now} onOpen={onOpen} />
          {others.map((item, index) => (
            <li key={`${item.kind}:${'id' in item ? item.id : index}`}><OtherRow item={item} now={now} onOpenSubagent={onOpenSubagent} /></li>
          ))}
        </Section>
      ) : null}
      {finished.length ? (
        <Section title="Finished since the last turn">
          <SessionTree nodes={finished} now={now} onOpen={onOpen} />
        </Section>
      ) : null}
    </>
  )
}

/**
 * What a session's bottom-bar status is waiting on, read from the gateway while the popup is
 * open and kept live by the invalidations that refresh the session list. A session row that
 * leaves a later response stays, as "No longer available", until the popup closes.
 */
export default function SessionWaitsPopup({ sessionId, onClose, onOpenSubagent }: {
  sessionId: string
  onClose: () => void
  /** Shows a sub-agent's conversation. The popup closes first: the view outlives it. */
  onOpenSubagent?: (agent: SubagentRef) => void
}) {
  const openSession = useOpenSession()
  const now = useNow()
  const { data, isError } = useQuery({
    queryKey: queryKeys.sessionWaits(sessionId),
    queryFn: ({ signal }) => api.getSessionWaits(sessionId, signal),
    refetchInterval: REFRESH_MS,
    staleTime: 0,
    gcTime: 0,
  })
  const known = useRef(new Map<string, DelegatedSessionWait | GoneSessionWait>())
  const rows = useMemo(() => (data ? retainGoneSessions(data.items, known.current) : []), [data])
  const empty = data !== undefined && data.items.length === 0

  useEffect(() => {
    if (!empty) return
    const timer = window.setTimeout(onClose, EMPTY_CLOSE_MS)
    return () => window.clearTimeout(timer)
  }, [empty, onClose])

  const sections = useMemo(() => sectionWaits(rows, sessionId), [rows, sessionId])
  const open = (target: string) => {
    openSession(target)
    onClose()
  }

  const openSubagent = onOpenSubagent && ((task: BackgroundTaskWait) => {
    onOpenSubagent({ id: task.id, description: task.description, agentType: task.agentType })
    onClose()
  })

  if (!data) return <WaitsNote>{isError ? 'Could not load what this session is waiting on.' : 'Loading…'}</WaitsNote>
  if (empty) return <WaitsNote>Nothing pending</WaitsNote>
  return (
    <Sections
      nodes={sections.waiting.sessions}
      finished={sections.finished}
      others={sections.waiting.others}
      now={now}
      onOpen={open}
      onOpenSubagent={openSubagent}
    />
  )
}
