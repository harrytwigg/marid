import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { GatewayEventListener } from '@jinn/gateway-events'
import { splitTitleId } from '@/components/chat/chat-tabs'
import { isChatTabId, TODOS_TAB_ID, TODOS_TAB_TITLE } from './layout/tab-kind'
import { useMobileWorkingSetActivity, type MobileWorkingSetActivity } from './mobile-working-set-activity'
import { MobileSessionTabs, type MobileSessionTab } from './mobile-session-tabs'
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

const NO_PINNED: readonly string[] = []

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

/**
 * What the layout holds that the phone can show: its pinned tabs of those kinds (a chat, the Todos tab),
 * which lead the strip, and the Todos tab, which the phone opens as a screen of its own.
 */
export interface MobileLayoutTabs {
  /** `SplitLayout.pinned`: tabs of every kind, of which the phone keeps the ones it can show. */
  pinned: readonly string[]
  /** Present while the Todos tab is open in the layout. */
  todos?: { active: boolean; onSelect: () => void; onClose: () => void }
}

/** The strip's tabs in order: pinned ones first, then the opened chats, then an unpinned Todos tab. */
function stripOrder(chatIds: readonly string[], pinned: readonly string[], todosOpen: boolean): string[] {
  const first = pinned.filter((id) => isChatTabId(id) || (id === TODOS_TAB_ID && todosOpen))
  const todos = todosOpen && !first.includes(TODOS_TAB_ID) ? [TODOS_TAB_ID] : []
  return [...new Set([...first, ...chatIds, ...todos])]
}

/** The opened chats, with the ways one leaves: a close, the gateway reporting it deleted, or a lookup that finds it gone. */
function useTabIds({ committedId, systemPrimedId, sessions, subscribe, pinned }: {
  committedId: string | null
  systemPrimedId: string | null
  sessions: TabSessions
  subscribe: (listener: GatewayEventListener) => () => void
  /** Pinned tabs, which a close-all leaves in the list. */
  pinned: readonly string[]
}) {
  const [ids, setIds] = useOpenedTabIds(committedId, systemPrimedId)
  const dropTab = useCallback((sessionId: string) => setIds((current) => closeMobileTab(current, sessionId)), [setIds])
  const clearTabs = useCallback(() => setIds((current) => {
    const kept = current.filter((id) => pinned.includes(id))
    return kept.length === current.length ? current : kept
  }), [pinned, setIds])
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

/** What pressing a tab, and closing the one in front, do: a chat is selected or dropped, the Todos tab is
 *  opened or closed by the page. Neither switch replays an open's entrance. */
function useStripActions({ activeId, shownIds, todos, onSelect, dropTab }: {
  activeId: string | null
  shownIds: readonly string[]
  todos: MobileLayoutTabs['todos']
  onSelect: (sessionId: string) => void
  dropTab: (sessionId: string) => void
}) {
  const selectChat = useTabSwitchSelect(activeId, onSelect)
  const selectTab = useCallback((tabId: string) => (tabId === TODOS_TAB_ID ? todos?.onSelect() : selectChat(tabId)), [selectChat, todos])
  const frontId = todos?.active ? TODOS_TAB_ID : activeId
  const close = useCallback((tabId: string) => {
    const nextId = tabId === frontId ? neighbourAfterClose(shownIds, tabId) : null
    if (tabId === TODOS_TAB_ID) todos?.onClose()
    else dropTab(tabId)
    if (nextId) selectTab(nextId)
  }, [dropTab, frontId, selectTab, shownIds, todos])
  return { selectTab, close, frontId }
}

/** The phone's tab strip, which carries its own close-all. */
export interface MobileSessionTabsControls {
  /** The strip, or `undefined` while fewer than two chats are open (the header keeps its plain title). */
  strip: ReactNode | undefined
  /** Closes every open tab: the stored list is emptied, so a reload does not bring them back. */
  closeAll: () => void
}

/**
 * The phone's tab strip. The strip is `undefined` while fewer than two chats are
 * open, so the header keeps its plain centred title. Its close-all empties the
 * strip's own store first and then calls `onCloseAll`, the page's reset of
 * everything else: the store belongs to this hook, which is built before the page
 * can hold a handler that clears it.
 */
export function useMobileSessionTabs({
  committedId,
  systemPrimedId,
  activeId,
  sessions,
  subscribe,
  connectionSeq,
  onSelect,
  onCloseAll,
  layout,
}: {
  committedId: string | null
  systemPrimedId: string | null
  activeId: string | null
  sessions: TabSessions
  subscribe: (listener: GatewayEventListener) => () => void
  connectionSeq: number
  onSelect: (sessionId: string) => void
  /** The rest of a close-all, run after this hook has emptied the strip's list. */
  onCloseAll: () => void
  /** The layout's tabs the phone shows beside the opened chats (see MobileLayoutTabs). */
  layout?: MobileLayoutTabs
}) {
  const pinned = layout?.pinned ?? NO_PINNED
  const { ids, dropTab, clearTabs, offList } = useTabIds({ committedId, systemPrimedId, sessions, subscribe, pinned })
  // The focused chat always has a tab, even one nobody opened (a primed chat
  // that a deep link landed on) — it just does not persist.
  const chatIds = useMemo(() => (activeId && !ids.includes(activeId) ? [...ids, activeId] : ids), [activeId, ids])
  const todos = layout?.todos
  const todosOpen = Boolean(todos)
  const shownIds = useMemo(() => stripOrder(chatIds, pinned, todosOpen), [chatIds, pinned, todosOpen])
  const sessionIds = useMemo(() => shownIds.filter(isChatTabId), [shownIds])
  const activity = useMobileWorkingSetActivity({ sessionIds, activeId, subscribe, connectionSeq })
  const { selectTab, close, frontId } = useStripActions({ activeId, shownIds, todos, onSelect, dropTab })

  // Titles come from the session list, so until it arrives every tab would read "Chat".
  if (!sessions || shownIds.length < 2) return { strip: undefined, closeAll: clearTabs }
  return {
    closeAll: clearTabs,
    strip: (
      <MobileSessionTabStrip
        ids={shownIds} activeId={frontId} pinned={pinned} sessions={sessions} offList={offList}
        activity={activity} onSelect={selectTab} onClose={close}
        onCloseAll={shownIds.every((id) => pinned.includes(id)) ? undefined : () => { clearTabs(); onCloseAll() }}
      />
    ),
  }
}

interface MobileSessionTabStripProps {
  ids: readonly string[]
  activeId: string | null
  pinned: readonly string[]
  sessions: NonNullable<TabSessions>
  offList: Record<string, TabSession>
  activity: Record<string, MobileWorkingSetActivity>
  onSelect: (sessionId: string) => void
  onClose: (sessionId: string) => void
  onCloseAll?: () => void
}

/** The strip itself: a tab per open chat, titled from the session list or the off-list lookup. */
function MobileSessionTabStrip({ ids, activeId, pinned, sessions, offList, activity, onSelect, onClose, onCloseAll }: MobileSessionTabStripProps) {
  const sessionsById = new Map(sessions.map((session) => [String(session.id ?? ''), session]))
  return (
    <MobileSessionTabs
      activeId={activeId}
      onSelect={onSelect}
      onClose={onClose}
      onCloseAll={onCloseAll}
      tabs={ids.map((id): MobileSessionTab => (id === TODOS_TAB_ID
        ? { id, kind: 'todos', title: TODOS_TAB_TITLE, moved: false, pinned: pinned.includes(id) }
        : { id, title: tabTitle(sessionsById.get(id) ?? offList[id]), moved: activity[id]?.moved ?? false, pinned: pinned.includes(id) }
      ))}
    />
  )
}
