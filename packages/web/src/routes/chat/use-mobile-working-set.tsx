import type { GatewayEventListener } from '@hundredfold/gateway-events'
import { MobileWorkingSetNav } from './mobile-working-set-nav'
import { useMobileWorkingSetActivity } from './mobile-working-set-activity'

export function useMobileWorkingSet({
  sessionIds,
  activeId,
  sessions,
  subscribe,
  connectionSeq,
  onSelect,
}: {
  sessionIds: string[]
  activeId: string | null
  sessions: ReadonlyArray<{ id?: unknown; title?: unknown; employee?: unknown }>
  subscribe: (listener: GatewayEventListener) => () => void
  connectionSeq: number
  onSelect: (sessionId: string) => void
}) {
  const activity = useMobileWorkingSetActivity({ sessionIds, activeId, subscribe, connectionSeq })
  if (sessionIds.length < 2) return undefined
  const sessionsById = new Map(sessions.map((session) => [String(session.id ?? ''), session]))
  return (
    <MobileWorkingSetNav
      activeId={activeId}
      onSelect={onSelect}
      items={sessionIds.map((sessionId) => {
        const session = sessionsById.get(sessionId)
        return {
          id: sessionId,
          title: String(session?.title || session?.employee || 'Chat'),
          employee: typeof session?.employee === 'string' ? session.employee : undefined,
          ...activity[sessionId],
        }
      })}
    />
  )
}
