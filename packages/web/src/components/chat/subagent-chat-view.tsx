import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Bot } from '@/components/ui/icon'
import { queryKeys } from '@/lib/query-keys'
import { formatElapsed } from '@/lib/session-waits'
import { subagentMessages } from '@/lib/subagent-messages'
import {
  getSubagentTranscript,
  subagentIsLive,
  subagentRefetchMs,
  subagentUnavailableText,
  type SubagentRef,
  type SubagentTranscriptResponse,
} from '@/lib/subagent-transcript'
import { ChatMessages } from '@/components/chat/chat-messages'

const NOTE = 'm-0 px-4 py-8 text-center text-[length:var(--text-caption1)] text-[var(--text-secondary)]'

function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [])
  return now
}

/** Whether the sub-agent is working, re-judged each second but only a change re-renders: the transcript
 *  below must not redraw every row once a second for a clock. */
function useLive(data: SubagentTranscriptResponse | undefined): boolean {
  const [live, setLive] = useState(() => subagentIsLive(data, Date.now()))
  useEffect(() => {
    const judge = () => setLive(subagentIsLive(data, Date.now()))
    judge()
    const timer = window.setInterval(judge, 1_000)
    return () => window.clearInterval(timer)
  }, [data])
  return live
}

/** Its own clock, so the seconds ticking over redraw this and nothing else. */
function Activity({ data }: { data: SubagentTranscriptResponse | undefined }) {
  const now = useNow()
  if (!data?.available) return null
  const quiet = now - Date.parse(data.updatedAt)
  const live = subagentIsLive(data, now)
  return (
    <span data-testid="subagent-activity" data-live={live} className="flex shrink-0 items-center gap-1.5 text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
      <span
        aria-hidden="true"
        className={live ? 'h-1.5 w-1.5 rounded-full bg-[var(--system-orange)] animate-[jinn-pulse_1.4s_infinite] motion-reduce:animate-none' : 'h-1.5 w-1.5 rounded-full bg-[var(--text-tertiary)]'}
      />
      {live ? 'Working' : data.entries.at(-1)?.kind === 'text' ? 'Finished' : `Quiet for ${formatElapsed(quiet)}`}
    </span>
  )
}

function Unavailable({ data }: { data: Extract<SubagentTranscriptResponse, { available: false }> }) {
  return (
    <p data-testid="subagent-unavailable" className={NOTE}>
      <strong className="block pb-1 text-[var(--text-primary)]">Transcript not available</strong>
      {subagentUnavailableText(data.reason)}
    </p>
  )
}

/** The transcript in the chat's own transcript view, which follows the end while the reader is at it. */
function Conversation({ data, agentId, live }: { data: Extract<SubagentTranscriptResponse, { available: true }>; agentId: string; live: boolean }) {
  const messages = useMemo(
    () => subagentMessages(agentId, data.entries, Date.parse(data.updatedAt)),
    [agentId, data.entries, data.updatedAt],
  )
  return (
    <div data-testid="subagent-transcript" className="relative flex min-h-0 flex-1 flex-col">
      {data.truncated ? <p className="m-0 px-4 pt-2 text-center text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">Earlier messages are not shown.</p> : null}
      <ChatMessages messages={messages} loading={live} emptyState="Nothing yet." />
    </div>
  )
}

/**
 * A background sub-agent's conversation, read-only and live, in the chat's own transcript view: its
 * prompt, what it said and each tool call, as the chat shows a session's. There is no composer, since
 * a sub-agent takes no messages; a quiet line says so. Shown as a tab beside the chat that launched
 * it, or, where the layout has no tabs, in a sheet over that chat.
 */
export default function SubagentChatView({ sessionId, agent, padRight = false }: {
  sessionId: string
  agent: SubagentRef
  /** Leave room at the header's right for a close button drawn over it. */
  padRight?: boolean
}) {
  const { data, isError } = useQuery({
    queryKey: queryKeys.subagentTranscript(sessionId, agent.id),
    queryFn: ({ signal }) => getSubagentTranscript(sessionId, agent.id, signal),
    refetchInterval: (query) => subagentRefetchMs(query.state.data, Date.now()),
    staleTime: 0,
    gcTime: 0,
  })
  const live = useLive(data)
  return (
    <div data-testid="subagent-chat-view" className="flex min-h-0 flex-1 flex-col bg-[var(--bg)]">
      <header className={`flex shrink-0 items-center gap-3 px-4 pb-2 pt-3 ${padRight ? 'pr-12' : ''}`}>
        <Bot size={16} aria-hidden className="shrink-0 text-[var(--text-tertiary)]" />
        <div className="min-w-0 flex-1">
          <h2 data-testid="subagent-title" className="m-0 truncate text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
            {agent.description ?? 'Sub-agent'}
          </h2>
          <p className="m-0 truncate text-[length:var(--text-caption1)] text-[var(--text-secondary)]">
            {['Sub-agent', agent.agentType].filter(Boolean).join(' · ')}
          </p>
        </div>
        <Activity data={data} />
      </header>
      {data?.available ? <Conversation data={data} agentId={agent.id} live={live} /> : null}
      {data && !data.available ? <Unavailable data={data} /> : null}
      {!data ? <p className={NOTE}>{isError ? 'Could not load this sub-agent’s transcript.' : 'Loading…'}</p> : null}
      <p data-testid="subagent-readonly" className="m-0 shrink-0 border-t border-[var(--separator)] px-4 py-2 text-center text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
        Read-only: a sub-agent takes no messages. This follows it live.
      </p>
    </div>
  )
}
