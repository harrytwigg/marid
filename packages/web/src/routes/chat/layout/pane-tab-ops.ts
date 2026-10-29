import type { PaneTabItem, PaneTabStripProps } from './pane-tab-strip'
import { findGroup, paneSessionForTab, placeTab, type LayoutGroup, type SplitLayout } from './split-layout'
import { fileTabTitle, parseFileTabId } from './file-tab'
import { parseSubagentTabId, subagentTabTitle } from './subagent-tab'
import { isNewChatTabId, isTodosTabId, parseTodoTabId, TODOS_TAB_TITLE } from './tab-kind'

/** What the strip shows for one session; supplied by whoever knows the session list. */
export interface PaneTabSession {
  /** The session's own title; empty while it has none, which the tab shows as its employee's name. */
  title: string
  employee?: string
  /** The employee's display name, where the roster has it. */
  employeeName?: string
  status?: PaneTabItem['status']
}

export type PaneTabSessionLookup = (sessionId: string) => PaneTabSession | undefined

/** A chat's tab: its title, else its employee's name, else "Chat"; the tooltip adds the employee. */
function chatTabItem(sessionId: string, session: PaneTabSession | undefined, preview: boolean): PaneTabItem {
  const title = session?.title || session?.employeeName || 'Chat'
  return { id: sessionId, employee: session?.employee, status: session?.status, title, tooltip: chatTooltip(title, session?.employeeName), preview: preview || undefined }
}

/** "<title> — <employee>", or nothing to add when the title already is the employee's name. */
function chatTooltip(title: string, employeeName: string | undefined): string | undefined {
  return employeeName && employeeName !== title ? `${title} — ${employeeName}` : undefined
}

/** A group's tab list as strip items; the pinned ones are marked, and none of them can be closed. A
 * session the lookup does not know yet still gets a tab. */
export function paneTabItems(group: LayoutGroup, lookup: PaneTabSessionLookup, pinned: readonly string[] = []): PaneTabItem[] {
  return paneTabItemsOf(group, lookup).map((item) => (pinned.includes(item.id) ? { ...item, pinned: true, closable: false } : item))
}

function paneTabItemsOf(group: LayoutGroup, lookup: PaneTabSessionLookup): PaneTabItem[] {
  return group.tabs.map((sessionId) => {
    const file = parseFileTabId(sessionId)
    if (file) return { id: sessionId, kind: 'file', title: fileTabTitle(file.path), filePath: file.path }
    // The label reads the Todo's title from the mention preview cache (pane-kind-tab-label.tsx).
    const todoId = parseTodoTabId(sessionId)
    if (todoId) return { id: sessionId, kind: 'todo', title: todoId }
    const subagent = parseSubagentTabId(sessionId)
    if (subagent) return { id: sessionId, kind: 'subagent', title: subagentTabTitle(subagent) }
    if (isTodosTabId(sessionId)) return { id: sessionId, kind: 'todos', title: TODOS_TAB_TITLE }
    if (isNewChatTabId(sessionId)) return { id: sessionId, kind: 'new-chat', title: 'New chat' }
    return chatTabItem(sessionId, lookup(sessionId), group.previewTab === sessionId)
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
  keep: (sessionId: string) => void
  pin: (sessionId: string) => void
  unpin: (sessionId: string) => void
  /** Saves a chat tab's new title to its session. A strip has nowhere to show a failed save: the list refetches and the tab shows the title the session has. */
  rename?: (sessionId: string, title: string) => void | Promise<void>
}

type StripHandlers = Pick<PaneTabStripProps, 'onActivate' | 'onClose' | 'onReorder' | 'onMoveIn' | 'onDropSession' | 'onKeep' | 'onPin' | 'onUnpin' | 'onRename'>

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
    onKeep: ops.keep,
    onPin: ops.pin,
    onUnpin: ops.unpin,
    onRename: ops.rename ? (sessionId, title) => { void Promise.resolve(ops.rename?.(sessionId, title)).catch(() => {}) } : undefined,
  }
}
