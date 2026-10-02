import type { PaneTabItem, PaneTabStripProps } from './pane-tab-strip'
import { findGroup, type LayoutGroup, type SplitLayout } from './split-layout'
import { fileTabTitle, parseFileTabId } from './file-tab'

/** What the strip shows for one session; supplied by whoever knows the session list. */
export interface PaneTabSession {
  title: string
  employee?: string
  status?: PaneTabItem['status']
}

export type PaneTabSessionLookup = (sessionId: string) => PaneTabSession | undefined

/** A group's tab list as strip items. A session the lookup does not know yet still gets a tab. */
export function paneTabItems(group: LayoutGroup, lookup: PaneTabSessionLookup): PaneTabItem[] {
  return group.tabs.map((sessionId) => {
    const file = parseFileTabId(sessionId)
    if (file) return { id: sessionId, title: fileTabTitle(file.path), filePath: file.path }
    const session = lookup(sessionId)
    return { id: sessionId, ...session, title: session?.title || 'Chat', preview: group.previewTab === sessionId || undefined }
  })
}

/** The tab list the strip of `groupId` renders, or empty once the group is gone. */
export function tabsOfGroup(layout: SplitLayout, groupId: string, lookup: PaneTabSessionLookup): PaneTabItem[] {
  const group = findGroup(layout, groupId)
  return group ? paneTabItems(group, lookup) : []
}

/** The layout edits a strip can ask for, and the route move that follows a tab becoming the shown one. */
export interface PaneTabOps {
  /** Puts a tab in a group at a slot: adds a new one, moves one between groups, or re-orders. */
  place: (groupId: string, sessionId: string, index: number) => void
  /** Closes a tab; when it was the shown one, the route moves to the chat that takes its place. */
  close: (sessionId: string) => void
  /** Makes a tab the shown one, and its group's chat the route's. */
  select: (sessionId: string) => void
  pin: (sessionId: string) => void
}

type StripHandlers = Pick<PaneTabStripProps, 'onActivate' | 'onClose' | 'onReorder' | 'onMoveIn' | 'onDropSession' | 'onPin'>

/**
 * The strip's callbacks for one group. Re-ordering, moving between groups and adding a sidebar chat
 * are all one placement; placing a tab shows it, so the route follows.
 */
export function paneTabHandlers(groupId: string, ops: PaneTabOps): StripHandlers {
  const place = (sessionId: string, index: number) => {
    ops.place(groupId, sessionId, index)
    ops.select(sessionId)
  }
  return {
    onActivate: ops.select,
    onClose: ops.close,
    onReorder: place,
    onMoveIn: (_fromGroupId, sessionId, index) => place(sessionId, index),
    onDropSession: place,
    onPin: ops.pin,
  }
}
