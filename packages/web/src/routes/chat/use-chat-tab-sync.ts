import { useEffect, useMemo } from 'react'
import type { useChatTabs } from '@/hooks/use-chat-tabs'
import { useOffListTabSessions, type TabSession } from './use-off-list-tab-sessions'

type Tabs = Pick<ReturnType<typeof useChatTabs>, 'tabs' | 'reconcileTabs' | 'closeTabBySessionId'>
type ListedSession = { id: string; title?: string; status?: string; employee?: string }

/**
 * Keeps the open-chat tabs in step with the session list: listed chats bring
 * their status and title to their tabs, and a tab whose chat the list does not
 * carry (archived, or older than the loaded pages) is looked up rather than
 * dropped, and takes its status and title from the lookup. Only a lookup that finds the chat deleted closes its tab, so a chat
 * opened from search stays open and selected. A chat deleted while the page is
 * open closes through `session:deleted`; this catches one deleted while it was
 * closed.
 */
export function useChatTabSync(chatTabs: Tabs, sessions: ListedSession[] | undefined) {
  const { tabs, reconcileTabs, closeTabBySessionId } = chatTabs
  const tabIds = useMemo(() => tabs.flatMap((tab) => (tab.kind === 'session' ? [tab.sessionId] : [])), [tabs])
  const listedIds = useMemo(() => (sessions ? new Set(sessions.map((session) => session.id)) : null), [sessions])
  const found = useOffListTabSessions(tabIds, listedIds, closeTabBySessionId, { keepArchived: true })

  // A looked-up chat brings its title and status to its tab as a listed one does.
  const known = useMemo(
    () => (sessions ? [...sessions, ...Object.entries(found).map(([id, session]) => asListed(id, session))] : undefined),
    [found, sessions],
  )
  useEffect(() => {
    if (known) reconcileTabs(known)
  }, [known, reconcileTabs])
}

function asListed(id: string, session: TabSession): ListedSession {
  const text = (value: unknown) => (typeof value === 'string' ? value : undefined)
  return { id, title: text(session.title), status: text(session.status), employee: text(session.employee) }
}
