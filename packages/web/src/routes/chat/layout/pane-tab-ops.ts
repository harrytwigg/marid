import type { PaneTabItem, PaneTabStripProps } from './pane-tab-strip'
import { findGroup, paneSessionForTab, placeTab, type LayoutGroup, type SplitLayout } from './split-layout'
import { fileTabTitle, parseFileTabId } from './file-tab'
import { isNewChatTabId, parseTodoTabId } from './tab-kind'

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
    if (file) return { id: sessionId, kind: 'file', title: fileTabTitle(file.path), filePath: file.path }
    // The label reads the Todo's title from the mention preview cache (pane-kind-tab-label.tsx).
    const todoId = parseTodoTabId(sessionId)
    if (todoId) return { id: sessionId, kind: 'todo', title: todoId }
    if (isNewChatTabId(sessionId)) return { id: sessionId, kind: 'new-chat', title: 'New chat' }
    const session = lookup(sessionId)
    return { id: sessionId, ...session, title: session?.title || 'Chat', preview: group.previewTab === sessionId || undefined }
  })
}

/** The tab list the strip of `groupId` renders, or empty once the group is gone. */
export function tabsOfGroup(layout: SplitLayout, groupId: string, lookup: PaneTabSessionLookup): PaneTabItem[] {
  const group = findGroup(layout, groupId)
  return group ? paneTabItems(group, lookup) : []
}

/**
 * Shows a tab, then moves the route to its pane's chat: the tab itself for a chat, the chat it sits
 * beside for a document or a new chat, and nowhere when its pane holds no chat. The chat is resolved
 * on `after`, the layout once the tab is where it is going, so a tab placed a moment ago (not yet
 * committed) is found where it landed. Showing comes first for every kind: focusing a chat whose pane
 * shows another tab over it would keep that tab.
 */
export function selectTab(after: SplitLayout, tabId: string, show: (tabId: string) => void, route: (sessionId: string) => void): void {
  const chat = paneSessionForTab(after, tabId)
  show(tabId)
  if (chat) route(chat)
}

/** The layout edits a strip can ask for, and the route move that follows a tab becoming the shown one. */
export interface PaneTabOps {
  /** The layout the strip was drawn from, which a placement is applied to. */
  layout: SplitLayout
  /** Puts a tab in a group at a slot: adds a new one, moves one between groups, or re-orders. */
  place: (groupId: string, sessionId: string, index: number) => void
  /** Closes a tab; when it was the shown one, the route moves to the chat that takes its place. */
  close: (sessionId: string) => void
  /** Makes a tab the shown one, and its group's chat the route's (resolved on `after`, if given). */
  select: (sessionId: string, after?: SplitLayout) => void
  pin: (sessionId: string) => void
}

type StripHandlers = Pick<PaneTabStripProps, 'onActivate' | 'onClose' | 'onReorder' | 'onMoveIn' | 'onDropSession' | 'onPin'>

/**
 * The strip's callbacks for one group. Re-ordering, moving between groups and adding a sidebar chat
 * are all one placement; placing a tab shows it, so the route follows.
 */
export function paneTabHandlers(groupId: string, ops: PaneTabOps): StripHandlers {
  const place = (sessionId: string, index: number) => {
    const after = placeTab(ops.layout, groupId, sessionId, index)
    ops.place(groupId, sessionId, index)
    ops.select(sessionId, after)
  }
  return {
    onActivate: (tabId) => ops.select(tabId),
    onClose: ops.close,
    onReorder: place,
    onMoveIn: (_fromGroupId, sessionId, index) => place(sessionId, index),
    onDropSession: place,
    onPin: ops.pin,
  }
}
