import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { PaneTabsContext, type PaneTabsBinding } from '@/components/chat/pane-tabs-context'
import { useSessions } from '@/hooks/use-sessions'
import { safePaneTitle } from '@/components/chat/chat-pane-title-bar'
import { paneTabHandlers, paneTabItems, type PaneTabSession } from './pane-tab-ops'
import { PaneTabStrip } from './pane-tab-strip'
import { closeSession, findGroup, groupOfSession, hasTabbedGroup } from './split-layout'
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
 * it; the page's pane-close would consult the flat working set, which holds only the shown tab of
 * each group and so cannot name that neighbour.
 */
function useCloseTab(split: SplitLayoutControls, onSelect: (sessionId: string) => void) {
  const { layout } = split
  return useCallback((sessionId: string) => {
    const owner = groupOfSession(layout, sessionId)
    const wasRoute = owner !== null && owner.activeTab === sessionId && layout.focusedGroupId === owner.id
    split.close(sessionId)
    const replacement = owner ? findGroup(closeSession(layout, sessionId), owner.id)?.activeTab : undefined
    if (wasRoute && replacement) onSelect(replacement)
  }, [layout, onSelect, split])
}

/** Mounts a PaneTabStrip in the title bar of every pane whose group holds more than one tab. */
export function PaneTabsProvider({ split, onSelect, children }: PaneTabsProviderProps) {
  const sessions = useSessions().data as SessionRow[] | undefined
  const byId = useMemo(() => new Map((sessions ?? []).map((row) => [String(row.id ?? ''), row])), [sessions])
  const { layout, pin } = split

  const keep = useKeepRequests(layout, pin)
  const closeTab = useCloseTab(split, onSelect)

  const binding = useMemo<PaneTabsBinding>(() => ({
    hasStrips: hasTabbedGroup(layout),
    keep,
    renderStrip: (sessionId) => {
      const group = groupOfSession(layout, sessionId)
      if (!group || group.tabs.length < 2) return null
      const ops = { place: split.place, close: closeTab, select: onSelect, pin }
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
  }), [byId, closeTab, keep, layout, onSelect, pin, split.place])

  return <PaneTabsContext.Provider value={binding}>{children}</PaneTabsContext.Provider>
}
