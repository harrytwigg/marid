import type { LayoutGroup } from './split-layout'
import { isNewChatTabId, isTodosTabId } from './tab-kind'

/**
 * The parts of the pinned-tab model the layout's own normalisation needs, kept apart from the ops
 * (pinned-tabs.ts) so split-layout.ts can use them without importing what imports it.
 */

/** A tab that holds a layout open on its own: the Todos board, or any pinned tab. Neither is a chat's
 * to take along when the chat closes, and either keeps the layout from emptying once the last chat goes. */
export function isStandaloneTab(pinned: readonly string[], tabId: string): boolean {
  return isTodosTabId(tabId) || pinned.includes(tabId)
}

/** `tabs` with the pinned ones first, each run in its existing order. Returns `tabs` itself when it
 * already reads that way, so an untouched group stays the same object. */
export function pinnedFirst(tabs: string[], pinned: readonly string[]): string[] {
  if (pinned.length === 0) return tabs
  const first = tabs.filter((id) => pinned.includes(id))
  const ordered = [...first, ...tabs.filter((id) => !pinned.includes(id))]
  return ordered.every((id, index) => id === tabs[index]) ? tabs : ordered
}

/** A group after an edit: its pinned tabs first, its shown tab and preview mark still among its tabs.
 * Null when it holds none. Returns `node` itself when nothing needed fixing. */
export function normalizeGroup(node: LayoutGroup, pinned: readonly string[]): LayoutGroup | null {
  if (node.tabs.length === 0) return null
  const tabs = pinnedFirst(node.tabs, pinned)
  const activeTab = tabs.includes(node.activeTab) ? node.activeTab : tabs[0]
  const { previewTab, ...rest } = node
  const keptPreview = previewTab !== undefined && tabs.includes(previewTab)
  if (tabs === node.tabs && activeTab === node.activeTab && keptPreview === (previewTab !== undefined)) return node
  return keptPreview ? { ...rest, tabs, activeTab, previewTab } : { ...rest, tabs, activeTab }
}

/**
 * The group eviction closes next, from `open` (least recently focused first): one that is neither the
 * drop target (protected) nor holding a pinned tab, else one that merely holds none, else, with nothing
 * else left to close, a pane with a pinned tab.
 */
export function evictionVictim(open: readonly LayoutGroup[], protectedIds: readonly string[], pinned: readonly string[]): LayoutGroup | undefined {
  const holds = (g: LayoutGroup, ids: readonly string[]) => g.tabs.some((id) => ids.includes(id))
  return open.find((g) => !holds(g, protectedIds) && !holds(g, pinned)) ?? open.find((g) => !holds(g, pinned)) ?? open[0]
}

/** `pinned` once `removedId` is swapped for `replacementId`: the pin goes with the tab that left, except
 * a new chat that became that chat on its first send, which is the one tab and keeps it. */
export function pinnedAfterReplace(pinned: string[], removedId: string, replacementId: string): string[] {
  if (!pinned.includes(removedId)) return pinned
  const rest = pinned.filter((id) => id !== removedId)
  return isNewChatTabId(removedId) ? [...rest, replacementId] : rest
}
