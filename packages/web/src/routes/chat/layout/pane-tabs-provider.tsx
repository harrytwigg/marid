import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { PaneTabsContext, type PaneTabsBinding } from '@/components/chat/pane-tabs-context'
import { useSessions } from '@/hooks/use-sessions'
import { safePaneTitle } from '@/components/chat/chat-pane-title-bar'
import { paneTabHandlers, paneTabItems, type PaneTabSession } from './pane-tab-ops'
import { PaneTabStrip } from './pane-tab-strip'
import { closeSession, findGroup, focusedGroup, groupOfSession, hasTabbedGroup, paneSessionOf, paneSessionForTab } from './split-layout'
import { parseFileTabId } from './file-tab'
import type { SplitLayoutControls } from './use-split-working-set'

interface SessionRow {
  id?: unknown
  title?: unknown
  employee?: unknown
  status?: unknown
}

function tabSession(row: SessionRow | undefined): PaneTabSession | undefined {
  if (!row) return undefined
  const status = row.status === 'running' || row.status === 'error' ? row.status : undefined
  return {
    title: safePaneTitle(row.title) ?? 'Chat',
    employee: typeof row.employee === 'string' ? row.employee : undefined,
    status,
  }
}

interface PaneTabsProviderProps {
  split: SplitLayoutControls
  /** Shows a session in its pane and moves the route to it. The grid's focus handler takes a pane
   * key, and a pane's key is its session id, so a tab's session id is a valid key here. */
  onSelect: (sessionId: string) => void
  children: ReactNode
}

/**
 * Working in a chat keeps its preview tab. A chat created by that first send is not in the layout
 * yet (the route adds it a beat later), so only then does the request wait until its tab exists; a
 * request left waiting for a tab that is already there would keep that chat's next preview too.
 */
function useKeepRequests(layout: SplitLayoutControls['layout'], pin: (sessionId: string) => void) {
  const waiting = useRef(new Set<string>())
  useEffect(() => {
    for (const sessionId of waiting.current) {
      if (!groupOfSession(layout, sessionId)) continue
      waiting.current.delete(sessionId)
      pin(sessionId)
    }
  }, [layout, pin])
  return useCallback((sessionId: string) => {
    if (groupOfSession(layout, sessionId)) pin(sessionId)
    else waiting.current.add(sessionId)
  }, [layout, pin])
}

/**
 * Closing the tab a pane shows hands the pane to the tab that takes its place, and the route follows
 * that pane's chat; the page's pane-close would consult the flat working set, which holds only the
 * chat of each group and so cannot name that neighbour. Closing a group's last chat closes the file
 * tabs beside it with it, and the route follows focus to wherever it lands.
 */
function useCloseTab(split: SplitLayoutControls, onSelect: (sessionId: string) => void) {
  const { layout } = split
  return useCallback((sessionId: string) => {
    const owner = groupOfSession(layout, sessionId)
    // The route is the focused pane's chat, which a file tab shown over it does not change.
    const wasRoute = owner !== null && layout.focusedGroupId === owner.id
      && (owner.activeTab === sessionId || paneSessionOf(owner, layout.focusHistory) === sessionId)
    split.close(sessionId)
    if (!owner || !wasRoute) return
    const next = closeSession(layout, sessionId)
    const pane = findGroup(next, owner.id) ?? focusedGroup(next)
    const replacement = pane ? paneSessionOf(pane, next.focusHistory) : ''
    if (replacement) onSelect(replacement)
  }, [layout, onSelect, split])
}

/**
 * Activating a tab shows it, then moves the route to its pane's chat: the tab itself for a chat,
 * the chat it sits beside for a file. Showing first matters for both kinds — focusing a chat whose
 * pane shows a file over it keeps the file.
 */
function useSelectTab(split: SplitLayoutControls, onSelect: (sessionId: string) => void) {
  const { layout, show } = split
  return useCallback((tabId: string) => {
    const chat = paneSessionForTab(layout, tabId)
    show(tabId)
    if (chat) onSelect(chat)
  }, [layout, onSelect, show])
}

/** Mounts a PaneTabStrip in the title bar of every pane whose group holds more than one tab. */
export function PaneTabsProvider({ split, onSelect, children }: PaneTabsProviderProps) {
  const sessions = useSessions().data as SessionRow[] | undefined
  const byId = useMemo(() => new Map((sessions ?? []).map((row) => [String(row.id ?? ''), row])), [sessions])
  const { layout, pin } = split

  const keep = useKeepRequests(layout, pin)
  const closeTab = useCloseTab(split, onSelect)
  const selectTab = useSelectTab(split, onSelect)

  const binding = useMemo<PaneTabsBinding>(() => ({
    hasStrips: hasTabbedGroup(layout),
    keep,
    shownFile: (sessionId) => {
      const group = groupOfSession(layout, sessionId)
      if (!group || paneSessionOf(group, layout.focusHistory) !== sessionId) return null
      return parseFileTabId(group.activeTab)
    },
    renderStrip: (sessionId) => {
      const group = groupOfSession(layout, sessionId)
      if (!group || group.tabs.length < 2) return null
      const ops = { place: split.place, close: closeTab, select: selectTab, pin }
      return (
        <PaneTabStrip
          groupId={group.id}
          tabs={paneTabItems(group, (id) => tabSession(byId.get(id)))}
          activeId={group.activeTab}
          focused={layout.focusedGroupId === group.id}
          {...paneTabHandlers(group.id, ops)}
        />
      )
    },
  }), [byId, closeTab, keep, layout, pin, selectTab, split.place])

  return <PaneTabsContext.Provider value={binding}>{children}</PaneTabsContext.Provider>
}
