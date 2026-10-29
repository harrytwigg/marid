import { parseSelectedSession } from '@/components/chat/chat-route-helpers'
import { focusedGroup, groupsOf, openDocTab, paneSessionForTab, workingSetFromLayout, type SplitLayout } from './split-layout'
import { loadSplitLayout } from './split-layout-storage'
import { isChatTabId, isTodosTabId, TODOS_TAB_ID } from './tab-kind'

/** What the page asks of the layout about the Todos board's tab (tab-kind.ts). */

/** Whether the Todos tab is open in any pane. */
export function todosTabOpen(layout: SplitLayout): boolean {
  return groupsOf(layout).some((group) => group.tabs.some(isTodosTabId))
}

/** Whether the pane holding focus shows the Todos tab. */
export function todosTabFocused(layout: SplitLayout): boolean {
  const focused = focusedGroup(layout)
  return focused !== null && isTodosTabId(focused.activeTab)
}

/** Whether the layout holds panes and none of them a chat: standalone tabs alone (the Todos tab,
 * pinned documents), which the page then shows without a composer pane of the route's. */
export function isChatlessLayout(layout: SplitLayout): boolean {
  const groups = groupsOf(layout)
  return groups.length > 0 && groups.every((group) => !group.tabs.some(isChatTabId))
}

/** The chat the route should be on once the Todos tab opens: the one the pane that takes the tab holds; else,
 * with the tab in a pane of its own beside chats, the layout's own chat (the route must name one, or the page
 * draws its composer beside them); else none (a layout of standalone tabs alone). */
export function routeChatForTodosOpen(layout: SplitLayout): string | null {
  const next = openDocTab(layout, null, TODOS_TAB_ID)
  const { focusedId, sessionIds } = workingSetFromLayout(next)
  return paneSessionForTab(next, TODOS_TAB_ID) ?? focusedId ?? sessionIds.at(-1) ?? null
}

/**
 * Whether the page loads on a layout of standalone tabs alone, which nothing in the URL contradicts:
 * the newest chat the bare route would open stays closed, as it does after the last chat is closed
 * beside the Todos tab. Read from storage because the page asks before the layout hydrates.
 */
export function loadsChatless(search: string, storage: Pick<Storage, 'getItem'> | null): boolean {
  if (parseSelectedSession(search) || !storage) return false
  return isChatlessLayout(loadSplitLayout(storage))
}
