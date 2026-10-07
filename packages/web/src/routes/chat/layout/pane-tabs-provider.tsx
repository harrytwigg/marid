import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { PaneTabsContext, type PaneTabsBinding, type PaneTitleDrag } from '@/components/chat/pane-tabs-context'
import { useSessions } from '@/hooks/use-sessions'
import { safePaneTitle } from '@/components/chat/chat-pane-title-bar'
import { paneTabHandlers, paneTabItems, selectTab, type PaneTabSession } from './pane-tab-ops'
import { PaneTabStrip } from './pane-tab-strip'
import { closeSession, findGroup, focusedGroup, groupIdsByPaneKey, groupOfSession, hasTabbedGroup, isLastChatWithTabs, paneSessionOf, routeSessionOf, workingSetFromLayout, type LayoutGroup, type SplitLayout } from './split-layout'
import { parseDocTabId } from './tab-kind'
import { DocPane, DocPaneTitle } from './doc-pane'
import { paneTabDragProps } from './pane-tab-dnd'
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
 * chat of each group and so cannot name that neighbour. Closing a group's last chat closes the
 * documents beside it with it, and the route follows focus to wherever it lands.
 */
/** Whether `sessionId` (a tab of `owner`) is the chat the route is on: its pane's, when that pane has
 * focus, or the working set's when a pane with no chat has it instead. */
function isRouteChat(layout: SplitLayout, owner: LayoutGroup, sessionId: string): boolean {
  const shownInFocused = layout.focusedGroupId === owner.id
    && (owner.activeTab === sessionId || paneSessionOf(owner, layout.focusHistory) === sessionId)
  return shownInFocused || workingSetFromLayout(layout).focusedId === sessionId
}

function useCloseTab(split: SplitLayoutControls, onSelect: (sessionId: string) => void) {
  const { layout } = split
  return useCallback((sessionId: string) => {
    if (isLastChatWithTabs(layout, sessionId)) return
    const owner = groupOfSession(layout, sessionId)
    // The route is the focused pane's chat, which a document shown over it does not change. With a
    // pane that has no chat focused it is the working set's chat, so the route is that one's.
    const wasRoute = owner !== null && isRouteChat(layout, owner, sessionId)
    split.close(sessionId)
    if (!owner || !wasRoute) return
    const next = closeSession(layout, sessionId)
    const pane = findGroup(next, owner.id) ?? focusedGroup(next)
    const replacement = (pane ? routeSessionOf(pane, next.focusHistory) : '') || workingSetFromLayout(next).focusedId
    if (replacement) onSelect(replacement)
  }, [layout, onSelect, split])
}

/** Activating a tab, or placing one (resolved on the layout it lands in): selectTab. */
function useSelectTab(split: SplitLayoutControls, onSelect: (sessionId: string) => void) {
  const { layout, show } = split
  return useCallback((tabId: string, after: SplitLayout = layout) => selectTab(after, tabId, show, onSelect), [layout, onSelect, show])
}

/** The drag a lone pane's title bar carries: its tab's, as the strip would start it. A drag that
 *  starts in something portaled out of the bar (a menu) bubbles here through React, and is not one. */
function titleDragFor(group: LayoutGroup, tabId: string): PaneTitleDrag {
  const { onDragStart, onDragEnd } = paneTabDragProps({ groupId: group.id, tabId })
  return {
    draggable: true,
    onDragStart: (event) => { if (event.currentTarget.contains(event.target as Node)) onDragStart(event) },
    onDragEnd,
  }
}

/** A document-only pane, by its pane key: under its strip, or alone under a title bar that drags it. */
function docPane(layout: SplitLayout, paneKey: string, groupStrip: (group: LayoutGroup) => ReactNode, closeTab: (tabId: string) => void) {
  const group = findGroup(layout, groupIdsByPaneKey(layout).get(paneKey) ?? '')
  const doc = group ? parseDocTabId(group.activeTab) : null
  if (!group || !doc) return null
  const active = layout.focusedGroupId === group.id
  const drag = titleDragFor(group, group.activeTab)
  const header = group.tabs.length >= 2
    ? groupStrip(group)
    : <DocPaneTitle doc={doc} active={active} drag={drag} onClose={() => closeTab(group.activeTab)} />
  return <DocPane doc={doc} header={header} active={active} />
}

/**
 * Mounts a PaneTabStrip in the title bar of every pane whose group holds more than one tab, and only
 * those: a pane holding one tab (a chat, a new chat, a document) shows its plain title bar instead,
 * which drags that tab as a strip would.
 */
export function PaneTabsProvider({ split, onSelect, children }: PaneTabsProviderProps) {
  const sessions = useSessions().data as SessionRow[] | undefined
  const byId = useMemo(() => new Map((sessions ?? []).map((row) => [String(row.id ?? ''), row])), [sessions])
  const { layout, pin } = split

  const keep = useKeepRequests(layout, pin)
  const closeTab = useCloseTab(split, onSelect)
  const selectChosenTab = useSelectTab(split, onSelect)

  const binding = useMemo<PaneTabsBinding>(() => {
    const ops = { layout, place: split.place, close: closeTab, select: selectChosenTab, pin }
    const groupStrip = (group: LayoutGroup) => (
      <PaneTabStrip
        groupId={group.id}
        tabs={paneTabItems(group, (id) => tabSession(byId.get(id))).map((tab) => (isLastChatWithTabs(layout, tab.id) ? { ...tab, closable: false } : tab))}
        activeId={group.activeTab}
        focused={layout.focusedGroupId === group.id}
        {...paneTabHandlers(group.id, ops)}
      />
    )
    return {
      hasStrips: hasTabbedGroup(layout),
      keep,
      closable: (sessionId) => !isLastChatWithTabs(layout, sessionId),
      shownDoc: (paneTabId) => {
        const group = groupOfSession(layout, paneTabId)
        if (!group || paneSessionOf(group, layout.focusHistory) !== paneTabId) return null
        return parseDocTabId(group.activeTab)
      },
      renderStrip: (paneTabId) => {
        const group = groupOfSession(layout, paneTabId)
        return group && group.tabs.length >= 2 ? groupStrip(group) : null
      },
      titleDrag: (paneTabId) => {
        const group = groupOfSession(layout, paneTabId)
        return group && group.tabs.length === 1 ? titleDragFor(group, paneTabId) : null
      },
      renderDocPane: (paneKey) => docPane(layout, paneKey, groupStrip, closeTab),
    }
  }, [byId, closeTab, keep, layout, pin, selectChosenTab, split.place])

  return <PaneTabsContext.Provider value={binding}>{children}</PaneTabsContext.Provider>
}
