import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { GatewayEventListener } from '@jinn/gateway-events'
import { splitTitleId } from '@/components/chat/chat-tabs'
import { useMobileWorkingSetActivity, type MobileWorkingSetActivity } from './mobile-working-set-activity'
import { MobileSessionTabs } from './mobile-session-tabs'
import { useTabSwitchSelect } from '@/components/chat/tab-switch-mark'
import { useOffListTabSessions, type TabSession } from './use-off-list-tab-sessions'
import {
  closeMobileTab,
  loadPersistedMobileTabs,
  neighbourAfterClose,
  openMobileTab,
  persistMobileTabs,
} from './mobile-session-tabs-model'

type TabSessions = ReadonlyArray<TabSession> | undefined

/** The list and the desktop title set a "#12 - " id apart from the name; a tab has no room for it. */
function tabTitle(session: TabSession | undefined): string {
  return splitTitleId(String(session?.title || '')).rest || String(session?.employee || 'Chat')
}

/**
 * The persisted list of opened chats. A chat earns a tab by being opened: the
 * committed selection, minus the chat the route primes on load
 * (`systemPrimedId`), which nobody asked for. Nothing else adds one, and only a
 * close or positive evidence that the chat is gone removes one.
 */
function useOpenedTabIds(committedId: string | null, systemPrimedId: string | null) {
  const openedId = committedId && committedId !== systemPrimedId ? committedId : null
  const [ids, setIds] = useState<string[]>(() => (
    typeof window === 'undefined' ? [] : loadPersistedMobileTabs(window.localStorage)
  ))

  useEffect(() => {
    if (openedId) setIds((current) => openMobileTab(current, openedId))
  }, [openedId])

  useEffect(() => {
    if (typeof window !== 'undefined') persistMobileTabs(window.localStorage, ids)
  }, [ids])

  return [ids, setIds] as const
}

/** The opened chats, with the ways one leaves: a close, the gateway reporting it deleted, or a lookup that finds it gone. */
function useTabIds({ committedId, systemPrimedId, sessions, subscribe }: {
  committedId: string | null
  systemPrimedId: string | null
  sessions: TabSessions
  subscribe: (listener: GatewayEventListener) => () => void
}) {
  const [ids, setIds] = useOpenedTabIds(committedId, systemPrimedId)
  const dropTab = useCallback((sessionId: string) => setIds((current) => closeMobileTab(current, sessionId)), [setIds])
  const clearTabs = useCallback(() => setIds((current) => (current.length === 0 ? current : [])), [setIds])
  const listedIds = useMemo(
    () => (sessions ? new Set(sessions.map((session) => String(session.id ?? ''))) : null),
    [sessions],
  )
  // An archived chat stays viewable, so it keeps its tab as it does on the desktop.
  const offList = useOffListTabSessions(ids, listedIds, dropTab, { keepArchived: true })

  useEffect(() => subscribe((frame) => {
    const payload = frame.payload as { sessionId?: unknown } | null
    if (frame.event === 'session:deleted' && typeof payload?.sessionId === 'string') dropTab(payload.sessionId)
  }), [subscribe, dropTab])

  return { ids, dropTab, clearTabs, offList }
}

/** The phone's tab strip and the close-all the page's header menu runs. */
export interface MobileSessionTabsControls {
  /** The strip, or `undefined` while fewer than two chats are open (the header keeps its plain title). */
  strip: ReactNode | undefined
  /** Closes every open tab: the stored list is emptied, so a reload does not bring them back. */
  closeAll: () => void
}

/**
 * The phone's tab strip (and the close-all the header menu runs). The strip is
 * `undefined` while fewer than two chats are open, so the header keeps its plain
 * centred title.
 */
export function useMobileSessionTabs({
  committedId,
  systemPrimedId,
  activeId,
  sessions,
  subscribe,
  connectionSeq,
  onSelect,
}: {
  committedId: string | null
  systemPrimedId: string | null
  activeId: string | null
  sessions: TabSessions
  subscribe: (listener: GatewayEventListener) => () => void
  connectionSeq: number
  onSelect: (sessionId: string) => void
}) {
  const { ids, dropTab, clearTabs, offList } = useTabIds({ committedId, systemPrimedId, sessions, subscribe })
  // The focused chat always has a tab, even one nobody opened (a primed chat
  // that a deep link landed on) — it just does not persist.
  const shownIds = useMemo(() => (activeId && !ids.includes(activeId) ? [...ids, activeId] : ids), [activeId, ids])
  const activity = useMobileWorkingSetActivity({ sessionIds: shownIds, activeId, subscribe, connectionSeq })

  // Pressing a tab and closing the one in front both switch chats: neither replays an open's entrance.
  const selectTab = useTabSwitchSelect(activeId, onSelect)
  const close = useCallback((sessionId: string) => {
    const nextId = sessionId === activeId ? neighbourAfterClose(shownIds, sessionId) : null
    dropTab(sessionId)
    if (nextId) selectTab(nextId)
  }, [activeId, dropTab, selectTab, shownIds])

  // Titles come from the session list, so until it arrives every tab would read "Chat".
  if (!sessions || shownIds.length < 2) return { strip: undefined, closeAll: clearTabs }
  return {
    closeAll: clearTabs,
    strip: (
      <MobileSessionTabStrip
        ids={shownIds}
        activeId={activeId}
        sessions={sessions}
        offList={offList}
        activity={activity}
        onSelect={selectTab}
        onClose={close}
      />
    ),
  }
}

interface MobileSessionTabStripProps {
  ids: readonly string[]
  activeId: string | null
  sessions: NonNullable<TabSessions>
  offList: Record<string, TabSession>
  activity: Record<string, MobileWorkingSetActivity>
  onSelect: (sessionId: string) => void
  onClose: (sessionId: string) => void
}

/** The strip itself: a tab per open chat, titled from the session list or the off-list lookup. */
function MobileSessionTabStrip({ ids, activeId, sessions, offList, activity, onSelect, onClose }: MobileSessionTabStripProps) {
  const sessionsById = new Map(sessions.map((session) => [String(session.id ?? ''), session]))
  return (
    <MobileSessionTabs
      activeId={activeId}
      onSelect={onSelect}
      onClose={onClose}
      tabs={ids.map((id) => ({
        id,
        title: tabTitle(sessionsById.get(id) ?? offList[id]),
        moved: activity[id]?.moved ?? false,
      }))}
    />
  )
}
