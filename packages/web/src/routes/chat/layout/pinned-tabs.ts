import {
  closeSession,
  emptySplitLayout,
  groupOfSession,
  groupsOf,
  isLastChatWithTabs,
  mapNodes,
  normalizeLayout,
  type LayoutGroup,
  type SplitLayout,
} from './split-layout'
import { isChatTabId } from './tab-kind'

/**
 * Pinned tabs. `SplitLayout.pinned` names them, whatever their kind, and each group keeps its pinned
 * tabs first, in their own order: normalisation (split-layout.ts) restores that after any edit, which
 * is also what clamps a drop, so a pinned tab dropped among unpinned ones lands at the end of the
 * pinned run and an unpinned one dropped into the run lands right after it. A pinned tab is
 * standalone (pinned-order.ts): no chat takes it along when it closes, and it keeps the layout open
 * without one. The user cannot close it (closeUserTab); a deleted or archived session still goes.
 */

export function isPinned(layout: SplitLayout, tabId: string): boolean {
  return layout.pinned.includes(tabId)
}

/** The group with its tabs set to `tabs`, and its preview mark gone when it was on `kept`. */
function reorderedGroup(owner: LayoutGroup, tabs: string[], kept: string): LayoutGroup {
  const { previewTab, ...rest } = owner
  return previewTab === undefined || previewTab === kept ? { ...rest, tabs } : { ...rest, tabs, previewTab }
}

function withGroupTabs(layout: SplitLayout, owner: LayoutGroup, tabs: string[], pinned: string[]): SplitLayout {
  if (!layout.root) return layout
  const group = reorderedGroup(owner, tabs, '')
  return { ...layout, pinned, root: mapNodes(layout.root, (node) => (node === owner ? group : node)) }
}

/** Pins a tab, at the end of its group's pinned run. A preview tab is kept as well: a pinned tab is
 * never replaced by the next ordinary open. */
export function pinTab(layout: SplitLayout, tabId: string): SplitLayout {
  const owner = groupOfSession(layout, tabId)
  if (!owner || !layout.root || isPinned(layout, tabId)) return layout
  const rest = owner.tabs.filter((id) => id !== tabId)
  const tabs = [...rest.filter((id) => isPinned(layout, id)), tabId, ...rest.filter((id) => !isPinned(layout, id))]
  const group = reorderedGroup(owner, tabs, tabId)
  return { ...layout, pinned: [...layout.pinned, tabId], root: mapNodes(layout.root, (node) => (node === owner ? group : node)) }
}

/** Unpins a tab, to the start of its group's unpinned run. A layout the tab alone kept open (a pinned
 * document with no chat) closes with it, as any document without a chat does. */
export function unpinTab(layout: SplitLayout, tabId: string): SplitLayout {
  const owner = groupOfSession(layout, tabId)
  if (!owner || !isPinned(layout, tabId)) return layout
  const rest = owner.tabs.filter((id) => id !== tabId)
  const pinned = layout.pinned.filter((id) => id !== tabId)
  const tabs = [...rest.filter((id) => pinned.includes(id)), tabId, ...rest.filter((id) => !pinned.includes(id))]
  return normalizeLayout(withGroupTabs(layout, owner, tabs, pinned))
}

/** Whether the user can close the tab: not a pinned one, and not the only chat beside other documents. */
export function canCloseTab(layout: SplitLayout, tabId: string): boolean {
  return !isPinned(layout, tabId) && !isLastChatWithTabs(layout, tabId)
}

/** closeSession for a close the user asked for (a strip, a title bar, a shortcut): a pinned tab stays. */
export function closeUserTab(layout: SplitLayout, tabId: string): SplitLayout {
  return isPinned(layout, tabId) ? layout : closeSession(layout, tabId)
}

/**
 * Close all: every unpinned tab goes, and the pinned ones stay where they were. A group left with no
 * pinned tab closes, and focus falls back by recency (a group whose shown tab went shows its most
 * recent pinned tab). With nothing pinned it is the layout of a first visit.
 */
export function closeAllUnpinned(layout: SplitLayout): SplitLayout {
  if (layout.pinned.length === 0 || !layout.root) return emptySplitLayout()
  const root = mapNodes(layout.root, (node) => {
    if (node.type !== 'group') return node
    const tabs = node.tabs.filter((id) => isPinned(layout, id))
    if (tabs.length === node.tabs.length) return node
    const recent = [...layout.focusHistory].reverse().find((id) => tabs.includes(id))
    const activeTab = tabs.includes(node.activeTab) ? node.activeTab : recent ?? tabs[0] ?? ''
    return reorderedGroup({ ...node, activeTab }, tabs, '')
  })
  return normalizeLayout({ ...layout, root })
}

/** Whether Close all has anything to close: a tab of the layout that is not pinned. */
export function hasUnpinnedTabs(layout: SplitLayout): boolean {
  return groupsOf(layout).some((group) => group.tabs.some((id) => !isPinned(layout, id)))
}

/** The pinned sessions: the chats Close all leaves in the legacy open-chats list. */
export function pinnedChats(layout: SplitLayout): string[] {
  return layout.pinned.filter(isChatTabId)
}
