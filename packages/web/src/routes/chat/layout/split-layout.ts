import type { ChatWorkingSet } from '../working-set'
import { isFileTabId } from './file-tab'

/**
 * The editor-group layout: a tree of row/column splits whose leaves are groups, each holding an
 * ordered tab list and the tab it shows. It is the source of truth for the multi-pane surface;
 * the flat working set the rest of the page reads (URL sync, eviction, the phone path) is
 * projected from it by workingSetFromLayout, one member per group.
 *
 * `auto` marks a layout the operator has not arranged yet. Its root is a flat row of groups and
 * its geometry is the upstream auto grid (grid-layout.ts / grid-cells.ts), so a working set that
 * was never split looks and drops exactly as it did before this model existed. The first split
 * or resize materializes it into real rows and columns and clears the flag.
 *
 * A tab is a session id or a file tab id (file-tab.ts): a file preview. A group usually holds a
 * chat, which is the pane's chat whichever tab it shows (paneSessionOf), and the file tabs opened
 * beside it. A file tab dragged out to its own pane makes a file-only group, whose pane key is its
 * shown file tab (paneKeyOf). The layout as a whole must hold at least one chat — the route needs
 * one — so it empties when its last chat goes, taking every file pane with it. The working set and
 * the URL only ever see chats (workingSetFromLayout); the grid sees every pane (paneKeysFromLayout).
 */

export type SplitDirection = 'row' | 'column'
export type SplitSide = 'left' | 'right' | 'top' | 'bottom'

export interface LayoutGroup {
  type: 'group'
  id: string
  /** Presentation order of the group's tabs. Never empty: an emptied group is removed. */
  tabs: string[]
  activeTab: string
  /** The tab opened by ordinary navigation and not yet kept (VS Code's italic preview tab): one of
   * `tabs`, at most one per group. The next ordinary open replaces it; placing, moving, pinning or
   * working in it makes it an ordinary tab. */
  previewTab?: string
}

export interface LayoutSplit {
  type: 'split'
  id: string
  /** 'row' lays children out side by side, 'column' stacks them. */
  direction: SplitDirection
  /** At least two, and never a split of the same direction (those are flattened). */
  children: LayoutNode[]
  /** One per child, each positive, summing to 1. */
  sizes: number[]
}

export type LayoutNode = LayoutGroup | LayoutSplit

export interface SplitLayout {
  root: LayoutNode | null
  auto: boolean
  focusedGroupId: string | null
  /** Every tab, least to most recently focused. Drives eviction and tab fallback. */
  focusHistory: string[]
  /** Next id suffix. Ids are allocated from the layout so the ops stay pure and replayable. */
  nextId: number
}

export function emptySplitLayout(): SplitLayout {
  return { root: null, auto: true, focusedGroupId: null, focusHistory: [], nextId: 1 }
}

export function groupsOf(layout: SplitLayout): LayoutGroup[] {
  const groups: LayoutGroup[] = []
  const walk = (node: LayoutNode) => {
    if (node.type === 'group') groups.push(node)
    else node.children.forEach(walk)
  }
  if (layout.root) walk(layout.root)
  return groups
}

export function findGroup(layout: SplitLayout, groupId: string): LayoutGroup | null {
  return groupsOf(layout).find((group) => group.id === groupId) ?? null
}

export function groupOfSession(layout: SplitLayout, sessionId: string): LayoutGroup | null {
  return groupsOf(layout).find((group) => group.tabs.includes(sessionId)) ?? null
}

export function findSplit(layout: SplitLayout, splitId: string): LayoutSplit | null {
  let found: LayoutSplit | null = null
  const walk = (node: LayoutNode) => {
    if (found || node.type === 'group') return
    if (node.id === splitId) found = node
    else node.children.forEach(walk)
  }
  if (layout.root) walk(layout.root)
  return found
}

/** The focused group's tabs and shown tab when it holds more than one, else null: the list the
 * tab shortcuts (Cmd+Opt+1-9, Cmd+Shift+[ / ], Cmd+W) act on beside a visible strip. */
export function focusedGroupTabs(layout: SplitLayout): { tabs: string[]; active: string } | null {
  const group = focusedGroup(layout)
  return group && group.tabs.length > 1 ? { tabs: group.tabs, active: group.activeTab } : null
}

/** Whether any group holds more than one tab, so its pane shows a tab strip. */
export function hasTabbedGroup(layout: SplitLayout): boolean {
  return groupsOf(layout).some((group) => group.tabs.length > 1)
}

export function focusedGroup(layout: SplitLayout): LayoutGroup | null {
  return layout.focusedGroupId ? findGroup(layout, layout.focusedGroupId) : null
}

/**
 * The chat a group's pane belongs to: its shown tab when that is a chat, else (a file tab is shown)
 * its most recently focused chat. Empty for a file-only group, which has no chat: ask paneKeyOf
 * for what identifies its pane.
 */
export function paneSessionOf(target: LayoutGroup, focusHistory: readonly string[]): string {
  if (!isFileTabId(target.activeTab)) return target.activeTab
  const sessions = target.tabs.filter((id) => !isFileTabId(id))
  return [...focusHistory].reverse().find((id) => sessions.includes(id)) ?? sessions[0] ?? ''
}

/**
 * What identifies a group's pane in the grid: its chat for a group that holds one, else its shown
 * file tab (a file-only group). A file tab id never collides with a session id, and it is the id
 * the drag that made the pane carried.
 */
export function paneKeyOf(target: LayoutGroup, focusHistory: readonly string[]): string {
  return paneSessionOf(target, focusHistory) || target.activeTab
}

/** Every pane's key, in tree order: the working set's chats plus the file-only panes. */
export function paneKeysFromLayout(layout: SplitLayout): string[] {
  return groupsOf(layout).map((group) => paneKeyOf(group, layout.focusHistory))
}

/**
 * Whether `tabId` is the layout's only chat while a file tab is open anywhere in it. Closing it
 * would take every file with it and leave the route on a chat no pane holds, so it stays. A lone
 * chat with no files closes as it always has (beside a new-chat picker, which is a pane the layout
 * does not hold).
 */
export function isLastChatWithFiles(layout: SplitLayout, tabId: string): boolean {
  const tabs = groupsOf(layout).flatMap((group) => group.tabs)
  const chats = tabs.filter((id) => !isFileTabId(id))
  return chats.length === 1 && chats[0] === tabId && tabs.some(isFileTabId)
}

/** Each group's id by its pane's key: how a pane key (a session id, or a file tab id) finds its group. */
export function groupIdsByPaneKey(layout: SplitLayout): Map<string, string> {
  return new Map(groupsOf(layout).map((group) => [paneKeyOf(group, layout.focusHistory), group.id]))
}

/** The chat whose pane shows `tabId` once that tab is shown: the tab itself for a chat, the chat
 * it sits beside for a file. Null for a tab not in the layout. */
export function paneSessionForTab(layout: SplitLayout, tabId: string): string | null {
  if (!isFileTabId(tabId)) return groupOfSession(layout, tabId) ? tabId : null
  const shown = showTab(layout, tabId)
  const owner = groupOfSession(shown, tabId)
  return owner ? paneSessionOf(owner, shown.focusHistory) || null : null
}

/** The flat working set the upstream surfaces consume: each chat group's chat, in tree order. A
 * file-only pane has no chat and is not in it, so the URL and the persisted set never see a file. */
export function workingSetFromLayout(layout: SplitLayout): ChatWorkingSet {
  const sessionIds = groupsOf(layout).map((group) => paneSessionOf(group, layout.focusHistory)).filter(Boolean)
  const focused = focusedGroup(layout)
  return setOf(layout, sessionIds, focused ? paneSessionOf(focused, layout.focusHistory) : null)
}

/** workingSetFromLayout over every pane, file-only ones included: the keys the grid mounts, and the
 * set its capacity and overflow are worked out on. */
export function paneSetFromLayout(layout: SplitLayout): ChatWorkingSet {
  const focused = focusedGroup(layout)
  return setOf(layout, paneKeysFromLayout(layout), focused ? paneKeyOf(focused, layout.focusHistory) : null)
}

function setOf(layout: SplitLayout, ids: string[], focusedKey: string | null): ChatWorkingSet {
  const members = new Set(ids)
  const known = layout.focusHistory.filter((id) => members.has(id))
  const history = [...ids.filter((id) => !known.includes(id)), ...known]
  const focusedId = focusedKey || history.at(-1) || null
  if (focusedId) {
    history.splice(history.indexOf(focusedId), 1)
    history.push(focusedId)
  }
  return { sessionIds: ids, focusedId, focusHistory: history }
}

function allocate(layout: SplitLayout, prefix: 'g' | 's'): [string, SplitLayout] {
  return [`${prefix}${layout.nextId}`, { ...layout, nextId: layout.nextId + 1 }]
}

function group(id: string, tabs: string[], activeTab = tabs[0]): LayoutGroup {
  return { type: 'group', id, tabs, activeTab }
}

export function normalizeSizes(sizes: readonly number[], count: number): number[] {
  const valid = sizes.length === count && sizes.every((size) => Number.isFinite(size) && size > 0)
  if (!valid) return Array.from({ length: count }, () => 1 / count)
  const total = sizes.reduce((sum, size) => sum + size, 0)
  return sizes.map((size) => size / total)
}

/** Restores the structural invariants after any edit: no empty groups, no single-child or
 * same-direction-nested splits, sizes that sum to 1. (That the layout holds a chat is withRoot's.) */
function normalizeNode(node: LayoutNode): LayoutNode | null {
  if (node.type === 'group') {
    if (node.tabs.length === 0) return null
    const activeTab = node.tabs.includes(node.activeTab) ? node.activeTab : node.tabs[0]
    const { previewTab, ...rest } = node
    const keptPreview = previewTab !== undefined && node.tabs.includes(previewTab)
    if (activeTab === node.activeTab && keptPreview === (previewTab !== undefined)) return node
    return keptPreview ? { ...rest, activeTab, previewTab } : { ...rest, activeTab }
  }
  const children: LayoutNode[] = []
  const sizes: number[] = []
  const inputSizes = normalizeSizes(node.sizes, node.children.length)
  node.children.forEach((child, index) => {
    const normalized = normalizeNode(child)
    if (!normalized) return
    if (normalized.type === 'split' && normalized.direction === node.direction) {
      normalized.children.forEach((grandchild, grandIndex) => {
        children.push(grandchild)
        sizes.push(inputSizes[index] * normalized.sizes[grandIndex])
      })
      return
    }
    children.push(normalized)
    sizes.push(inputSizes[index])
  })
  if (children.length === 0) return null
  if (children.length === 1) return children[0]
  return { ...node, children, sizes: normalizeSizes(sizes, children.length) }
}

function mapNodes(node: LayoutNode, fn: (node: LayoutNode) => LayoutNode): LayoutNode {
  const mapped = fn(node)
  if (mapped !== node || mapped.type === 'group') return mapped
  const children = mapped.children.map((child) => mapNodes(child, fn))
  return children.every((child, index) => child === mapped.children[index])
    ? mapped
    : { ...mapped, children }
}

function holdsChat(root: LayoutNode): boolean {
  return groupsOf({ ...emptySplitLayout(), root }).some((group) => group.tabs.some((id) => !isFileTabId(id)))
}

function withRoot(layout: SplitLayout, root: LayoutNode | null): SplitLayout {
  // The route needs a chat: without one no pane is worth keeping, file panes included.
  const kept = root ? normalizeNode(root) : null
  const normalized = kept && holdsChat(kept) ? kept : null
  const groupCount = normalized ? countGroups(normalized) : 0
  const focusedStillThere = normalized && layout.focusedGroupId
    && groupsOf({ ...layout, root: normalized }).some((g) => g.id === layout.focusedGroupId)
  // A file tab that went with its group leaves history too: nothing will ever focus it again.
  const members = new Set(normalized ? groupsOf({ ...layout, root: normalized }).flatMap((g) => g.tabs) : [])
  // A single pane has no geometry worth keeping; dropping back to auto lets the next pane
  // arrive through the ordinary auto grid rather than a remembered 50/50 split.
  return {
    ...layout,
    root: normalized,
    auto: groupCount <= 1 ? true : layout.auto,
    focusedGroupId: focusedStillThere ? layout.focusedGroupId : null,
    focusHistory: layout.focusHistory.filter((id) => !isFileTabId(id) || members.has(id)),
  }
}

/** Re-establishes every invariant on a layout from outside the ops (storage). */
export function normalizeLayout(layout: SplitLayout): SplitLayout {
  const normalized = refocus(withRoot(layout, layout.root))
  const members = new Set(groupsOf(normalized).flatMap((g) => g.tabs))
  return { ...normalized, focusHistory: [...new Set(normalized.focusHistory)].filter((id) => members.has(id)) }
}

function countGroups(node: LayoutNode): number {
  return node.type === 'group' ? 1 : node.children.reduce((sum, child) => sum + countGroups(child), 0)
}

function touch(history: readonly string[], sessionId: string): string[] {
  return [...history.filter((id) => id !== sessionId), sessionId]
}

/** When focus is lost (its group closed), it falls to the group of the most recent survivor. */
function refocus(layout: SplitLayout): SplitLayout {
  if (layout.focusedGroupId || !layout.root) return layout
  for (let index = layout.focusHistory.length - 1; index >= 0; index -= 1) {
    const owner = groupOfSession(layout, layout.focusHistory[index])
    if (owner) return { ...layout, focusedGroupId: owner.id }
  }
  return { ...layout, focusedGroupId: groupsOf(layout).at(-1)?.id ?? null }
}

/** Removes one tab without touching focus history. An emptied group disappears; a group that
 * loses its shown tab falls back to its most recently focused remaining tab. */
function detach(layout: SplitLayout, sessionId: string): SplitLayout {
  const owner = groupOfSession(layout, sessionId)
  if (!owner || !layout.root) return layout
  const tabs = owner.tabs.filter((id) => id !== sessionId)
  let activeTab = owner.activeTab
  if (activeTab === sessionId) {
    const recent = [...layout.focusHistory].reverse().find((id) => tabs.includes(id))
    const index = owner.tabs.indexOf(sessionId)
    activeTab = recent ?? tabs[Math.min(index, tabs.length - 1)] ?? ''
  }
  const root = mapNodes(layout.root, (node) => (node === owner ? { ...owner, tabs, activeTab } : node))
  return withRoot(layout, root)
}

/** An unarranged layout of one single-tab group per session, in the given order. */
export function createSplitLayout(sessionIds: readonly string[] = [], focusedId: string | null = null): SplitLayout {
  let layout = emptySplitLayout()
  const ids = [...new Set(sessionIds.map((id) => id.trim()).filter(Boolean))]
  const groups: LayoutGroup[] = []
  for (const sessionId of ids) {
    const [id, next] = allocate(layout, 'g')
    layout = next
    groups.push(group(id, [sessionId]))
  }
  let root: LayoutNode | null = groups[0] ?? null
  if (groups.length > 1) {
    const [id, next] = allocate(layout, 's')
    layout = next
    root = { type: 'split', id, direction: 'row', children: groups, sizes: normalizeSizes([], groups.length) }
  }
  layout = { ...withRoot(layout, root), focusHistory: ids }
  const focus = focusedId && ids.includes(focusedId) ? focusedId : ids.at(-1)
  return focus ? focusSession(layout, focus) : layout
}

/**
 * Turns an auto layout into real rows and columns: the grid the operator is looking at, row-major,
 * `columns` wide. A short last row keeps its panes at column width and hands the gap to its last
 * pane, since a split cannot hold an empty cell. Arranged layouts pass through untouched.
 */
export function materializeLayout(layout: SplitLayout, columns: number): SplitLayout {
  if (!layout.auto) return layout
  const groups = groupsOf(layout)
  const width = Math.max(1, Math.floor(columns))
  if (groups.length <= 1) return { ...layout, auto: false }
  let next = layout
  const rows: LayoutNode[] = []
  for (let start = 0; start < groups.length; start += width) {
    const chunk = groups.slice(start, start + width)
    if (chunk.length === 1) {
      rows.push(chunk[0])
      continue
    }
    const sizes = chunk.map((_, index) => (
      index < chunk.length - 1 ? 1 / width : (width - chunk.length + 1) / width
    ))
    const [id, allocated] = allocate(next, 's')
    next = allocated
    rows.push({ type: 'split', id, direction: 'row', children: chunk, sizes })
  }
  if (rows.length === 1) return { ...next, auto: false, root: normalizeNode(rows[0]) }
  const [id, allocated] = allocate(next, 's')
  const root: LayoutSplit = { type: 'split', id, direction: 'column', children: rows, sizes: normalizeSizes([], rows.length) }
  return { ...allocated, auto: false, root: normalizeNode(root) }
}

/**
 * Focuses the group holding the session and shows that tab in it — unless the group is showing a
 * file tab over this very chat: focusing a pane, or the route landing on the chat it already
 * shows, keeps the file in view. Only showTab switches away from it.
 */
export function focusSession(layout: SplitLayout, sessionId: string): SplitLayout {
  const owner = groupOfSession(layout, sessionId)
  if (!owner) return layout
  const keepsFile = isFileTabId(owner.activeTab) && paneSessionOf(owner, layout.focusHistory) === sessionId
  return keepsFile ? focusGroupOn(layout, owner, owner.activeTab, sessionId) : showTab(layout, sessionId)
}

/** Focuses the group holding the tab and shows that tab in it, file or chat. */
export function showTab(layout: SplitLayout, tabId: string): SplitLayout {
  const owner = groupOfSession(layout, tabId)
  return owner ? focusGroupOn(layout, owner, tabId, tabId) : layout
}

/** `owner` focused, showing `activeTab`, with `touched` the most recent tab. */
function focusGroupOn(layout: SplitLayout, owner: LayoutGroup, activeTab: string, touched: string): SplitLayout {
  if (!layout.root) return layout
  if (owner.activeTab === activeTab && layout.focusedGroupId === owner.id && layout.focusHistory.at(-1) === touched) {
    return layout
  }
  const root = owner.activeTab === activeTab
    ? layout.root
    : mapNodes(layout.root, (node) => (node === owner ? { ...owner, activeTab } : node))
  return { ...layout, root, focusedGroupId: owner.id, focusHistory: touch(layout.focusHistory, touched) }
}

/**
 * Opens a file preview as a tab beside a chat: in the group holding `ownerSessionId`, else the
 * focused group, just after its shown tab, and shows it. A file already open anywhere is shown
 * where it is. With no group to hold it the layout is returned unchanged.
 */
export function openFileTab(layout: SplitLayout, ownerSessionId: string | null, fileTabId: string): SplitLayout {
  if (!isFileTabId(fileTabId)) return layout
  if (groupOfSession(layout, fileTabId)) return showTab(layout, fileTabId)
  // The linking chat is shown first, so the file lands beside it and it is the chat the file covers.
  const base = ownerSessionId && groupOfSession(layout, ownerSessionId) ? showTab(layout, ownerSessionId) : layout
  const owner = focusedGroup(base) ?? groupsOf(base).at(-1)
  return owner ? placeTab(base, owner.id, fileTabId) : layout
}

/**
 * Puts a session into a group as a tab at `index` (default: after the shown tab), shows it and
 * focuses the group. A session already in the layout moves: out of its old group (which closes
 * if that empties it), or to the new index within the same group. A group's only chat takes its
 * file tabs with it rather than strand them.
 */
export function placeTab(layout: SplitLayout, groupId: string, rawSessionId: string, index?: number): SplitLayout {
  const sessionId = rawSessionId.trim()
  const source = groupOfSession(layout, sessionId)
  if (source?.id === groupId && strandedFiles(layout, sessionId).length > 0) return reorderLoneChat(layout, source, sessionId, index)
  return keepingFiles(layout, sessionId, (current) => placeOnly(current, groupId, sessionId, index))
}

function placeOnly(layout: SplitLayout, groupId: string, sessionId: string, index?: number): SplitLayout {
  if (!sessionId || !findGroup(layout, groupId)) return layout
  const detached = detachForMove(layout, sessionId, groupId)
  const current = findGroup(detached, groupId)
  if (!current || !detached.root) return layout
  const tabs = [...current.tabs]
  tabs.splice(tabSlot(tabs, current.activeTab, index), 0, sessionId)
  const previewTab = current.previewTab === sessionId ? undefined : current.previewTab
  const root = mapNodes(detached.root, (node) => (node === current ? withPreview({ ...current, tabs, activeTab: sessionId }, previewTab) : node))
  return showTab(withRoot(detached, root), sessionId)
}

/**
 * The file tabs a chat would strand by leaving its group: all of the group's when it is the group's
 * only chat (they belong to it, so closing it closes them). A move carries them along instead.
 */
function strandedFiles(layout: SplitLayout, sessionId: string): string[] {
  const owner = isFileTabId(sessionId) ? null : groupOfSession(layout, sessionId)
  if (!owner || owner.tabs.some((id) => id !== sessionId && !isFileTabId(id))) return []
  return owner.tabs.filter(isFileTabId)
}

/** `move` applied to the layout, with any files the moving chat would strand put back beside it
 * where it lands, the chat shown. A move that does not happen changes nothing. */
export function keepingFiles(layout: SplitLayout, sessionId: string, move: (layout: SplitLayout) => SplitLayout): SplitLayout {
  const files = strandedFiles(layout, sessionId)
  const afterMove = move(layout)
  if (afterMove === layout || files.length === 0) return afterMove
  // Wherever the move left the files (their old group outlives the chat now), they leave it.
  const moved = files.reduce((current, id) => detach(current, id), afterMove)
  const owner = groupOfSession(moved, sessionId)
  if (!owner || !moved.root) return afterMove
  const tabs = owner.tabs.filter((id) => !files.includes(id))
  tabs.splice(tabs.indexOf(sessionId) + 1, 0, ...files)
  return showTab({ ...moved, root: mapNodes(moved.root, (node) => (node === owner ? { ...owner, tabs } : node)) }, sessionId)
}

/** A group's only chat re-ordered among its file tabs: in place, since detaching it would close the group. */
function reorderLoneChat(layout: SplitLayout, owner: LayoutGroup, sessionId: string, index?: number): SplitLayout {
  if (!layout.root) return layout
  const tabs = owner.tabs.filter((id) => id !== sessionId)
  const anchor = owner.activeTab === sessionId ? tabs[owner.tabs.indexOf(sessionId) - 1] : owner.activeTab
  tabs.splice(index === undefined && anchor === undefined ? 0 : tabSlot(tabs, anchor ?? '', index), 0, sessionId)
  const previewTab = owner.previewTab === sessionId ? undefined : owner.previewTab
  return showTab({ ...layout, root: mapNodes(layout.root, (node) => (node === owner ? withPreview({ ...owner, tabs }, previewTab) : node)) }, sessionId)
}

function tabSlot(tabs: readonly string[], activeTab: string, index: number | undefined): number {
  if (index === undefined || !Number.isInteger(index)) return tabs.indexOf(activeTab) + 1
  return Math.max(0, Math.min(index, tabs.length))
}

/** Takes a moving tab out of its current group. If that closes the focused group, focus
 * follows the tab to its destination instead of falling back by recency. */
function detachForMove(layout: SplitLayout, sessionId: string, destinationGroupId: string): SplitLayout {
  const source = groupOfSession(layout, sessionId)
  if (!source) return layout
  const closesFocused = source.id !== destinationGroupId && source.tabs.length === 1 && source.id === layout.focusedGroupId
  return detach(closesFocused ? { ...layout, focusedGroupId: destinationGroupId } : layout, sessionId)
}

/** Closes one tab. Its group closes with its last tab, and focus falls back by recency. A group's
 * only chat takes the file tabs beside it along (a file-only group has no chat to outlive). */
export function closeSession(layout: SplitLayout, sessionId: string): SplitLayout {
  if (!groupOfSession(layout, sessionId)) return layout
  const closing = [sessionId, ...strandedFiles(layout, sessionId)]
  const detached = closing.reduce((current, id) => detach(current, id), layout)
  return refocus({ ...detached, focusHistory: detached.focusHistory.filter((id) => !closing.includes(id)) })
}

/** Closes a whole group, every tab in it. */
export function closeGroup(layout: SplitLayout, groupId: string): SplitLayout {
  const target = findGroup(layout, groupId)
  if (!target) return layout
  return target.tabs.reduce(closeSession, layout)
}

/**
 * Swaps a session for another in the same tab slot, and focuses it. A replacement already in the
 * layout keeps its own slot and the departing tab simply closes, as in replaceWorkingSetSession.
 */
export function replaceSession(layout: SplitLayout, removedId: string, rawReplacementId: string): SplitLayout {
  const replacementId = rawReplacementId.trim()
  const owner = groupOfSession(layout, removedId)
  if (!owner || !layout.root) return layout
  if (!replacementId) return closeSession(layout, removedId)
  if (replacementId === removedId) return focusSession(layout, removedId)
  if (groupOfSession(layout, replacementId)) return focusSession(closeSession(layout, removedId), replacementId)
  const tabs = owner.tabs.map((id) => (id === removedId ? replacementId : id))
  const activeTab = owner.activeTab === removedId ? replacementId : owner.activeTab
  const previewTab = owner.previewTab === removedId ? replacementId : owner.previewTab
  const root = mapNodes(layout.root, (node) => (node === owner ? withPreview({ ...owner, tabs, activeTab }, previewTab) : node))
  const focusHistory = layout.focusHistory.filter((id) => id !== removedId)
  return showTab({ ...layout, root, focusHistory }, replacementId)
}

/** The group with `previewTab` set (or cleared when undefined). */
function withPreview(target: LayoutGroup, previewTab: string | undefined): LayoutGroup {
  const { previewTab: _dropped, ...rest } = target
  return previewTab === undefined ? rest : { ...rest, previewTab }
}

/** Makes the session an ordinary tab: it is no longer replaced by the next ordinary open. */
export function pinTab(layout: SplitLayout, sessionId: string): SplitLayout {
  const owner = groupOfSession(layout, sessionId)
  if (!owner || owner.previewTab !== sessionId || !layout.root) return layout
  return { ...layout, root: mapNodes(layout.root, (node) => (node === owner ? withPreview(owner, undefined) : node)) }
}

/**
 * Ordinary navigation: show the session where the operator is looking. A member is focused. A
 * newcomer becomes the focused group's preview tab: it replaces that group's existing preview tab
 * in its slot, or is added after the shown tab when there is none, so browsing the sidebar never
 * grows the layout by more than one tab per group.
 */
export function openInFocusedGroup(layout: SplitLayout, rawSessionId: string): SplitLayout {
  const sessionId = rawSessionId.trim()
  if (!sessionId || isFileTabId(sessionId)) return layout
  if (groupOfSession(layout, sessionId)) return focusSession(layout, sessionId)
  const target = focusedGroup(layout)
  if (!target) return groupsOf(layout).length === 0 ? createPreviewLayout(sessionId) : appendSession(layout, sessionId)
  if (target.previewTab !== undefined) return replaceSession(layout, target.previewTab, sessionId)
  return markPreview(placeTab(layout, target.id, sessionId), sessionId)
}

/**
 * The layout for a chat the route opened by itself (a deep link, the newest chat on a bare visit):
 * a lone preview tab, so the next ordinary open replaces it rather than growing a strip.
 */
export function createPreviewLayout(sessionId: string): SplitLayout {
  return markPreview(createSplitLayout([sessionId], sessionId), sessionId.trim())
}

function markPreview(layout: SplitLayout, sessionId: string): SplitLayout {
  const owner = groupOfSession(layout, sessionId)
  if (!owner || !layout.root) return layout
  return { ...layout, root: mapNodes(layout.root, (node) => (node === owner ? withPreview(owner, sessionId) : node)) }
}

/**
 * Adds a session as a new group without a drop position ("Open beside"). An unarranged layout
 * grows its flat row, which the auto grid reflows; an arranged one splits the focused group to
 * the right. A member is only focused.
 */
export function appendSession(layout: SplitLayout, rawSessionId: string): SplitLayout {
  const sessionId = rawSessionId.trim()
  if (!sessionId || isFileTabId(sessionId)) return layout
  if (groupOfSession(layout, sessionId)) return focusSession(layout, sessionId)
  return appendGroup(layout, sessionId)
}

/** `sessionId` (a chat, or a file tab) as a new group at the end of the layout, focused. */
function appendGroup(layout: SplitLayout, sessionId: string): SplitLayout {
  const [groupId, allocated] = allocate(layout, 'g')
  const added = group(groupId, [sessionId])
  if (!allocated.root) return focusSession(withRoot(allocated, added), sessionId)
  if (!layout.auto) {
    const target = focusedGroup(layout) ?? groupsOf(layout).at(-1)!
    return splitGroup(layout, target.id, 'right', sessionId)
  }
  const root = allocated.root
  if (root.type === 'split') {
    return focusSession(withRoot(allocated, { ...root, children: [...root.children, added], sizes: [...root.sizes, root.sizes.at(-1)!] }), sessionId)
  }
  const [splitId, withSplit] = allocate(allocated, 's')
  return focusSession(withRoot(withSplit, { type: 'split', id: splitId, direction: 'row', children: [root, added], sizes: [0.5, 0.5] }), sessionId)
}

/**
 * Moves a file tab of the layout out to a group of its own at the end ("the empty end of the grid"),
 * as appendSession does for a chat. A file already alone in its group is only shown.
 */
export function appendFileTab(layout: SplitLayout, fileTabId: string): SplitLayout {
  const owner = isFileTabId(fileTabId) ? groupOfSession(layout, fileTabId) : null
  if (!owner) return layout
  if (owner.tabs.length === 1) return showTab(layout, fileTabId)
  return appendGroup(detach(layout, fileTabId), fileTabId)
}

function parentOf(node: LayoutNode, childId: string): { parent: LayoutSplit; index: number } | null {
  if (node.type === 'group') return null
  const index = node.children.findIndex((child) => child.id === childId)
  if (index >= 0) return { parent: node, index }
  for (const child of node.children) {
    const found = parentOf(child, childId)
    if (found) return found
  }
  return null
}

/**
 * Splits a group on one side and puts the session in the new half, as a single-tab group that
 * takes focus. The target's share is halved, so the rest of the split keeps its proportions (it
 * gives up only its part of the new gutter). Along the parent's
 * own axis the new group becomes a sibling; across it, the target becomes a two-way split.
 * A session already in the layout moves here, taking along any file tabs it would strand (a group's
 * only chat); splitting a group with its own only tab is a no-op. A file tab in the layout splits
 * out as a file-only group. Materialize an auto layout first, or its flat row is split as a row.
 */
export function splitGroup(layout: SplitLayout, targetGroupId: string, side: SplitSide, rawSessionId: string): SplitLayout {
  const sessionId = rawSessionId.trim()
  return keepingFiles(layout, sessionId, (current) => splitOnly(current, targetGroupId, side, sessionId))
}

function splitOnly(layout: SplitLayout, targetGroupId: string, side: SplitSide, sessionId: string): SplitLayout {
  const detached = detachForSplit(layout, targetGroupId, sessionId)
  if (!detached?.root) return layout

  const direction: SplitDirection = side === 'left' || side === 'right' ? 'row' : 'column'
  const before = side === 'left' || side === 'top'
  const [groupId, allocated] = allocate(detached, 'g')
  const added = group(groupId, [sessionId])
  const found = parentOf(detached.root, targetGroupId)
  const [next, root] = found && found.parent.direction === direction
    ? [allocated, insertSibling(detached.root, found, added, before)]
    : wrapTarget(allocated, targetGroupId, added, direction, before)
  const arranged = { ...withRoot(next, root), auto: false }
  return isFileTabId(sessionId) ? showTab(arranged, sessionId) : focusSession(arranged, sessionId)
}

/** The layout with the session taken out of wherever it was, or null when the split cannot
 * happen: no such group, or a single-tab group split with its own tab. */
function detachForSplit(layout: SplitLayout, targetGroupId: string, sessionId: string): SplitLayout | null {
  const target = findGroup(layout, targetGroupId)
  if (!sessionId || !target || (target.tabs.length === 1 && target.activeTab === sessionId)) return null
  const detached = detach(layout, sessionId)
  return findGroup(detached, targetGroupId) ? detached : null
}

/** Along the parent's axis: the new group becomes the target's sibling and takes half its share. */
function insertSibling(root: LayoutNode, { parent, index }: { parent: LayoutSplit; index: number }, added: LayoutGroup, before: boolean): LayoutNode {
  const half = parent.sizes[index] / 2
  const children = [...parent.children]
  const sizes = [...parent.sizes]
  const slot = before ? index : index + 1
  sizes[index] = half
  children.splice(slot, 0, added)
  sizes.splice(slot, 0, half)
  return mapNodes(root, (node) => (node === parent ? { ...parent, children, sizes } : node))
}

/** Across the parent's axis: the target becomes a two-way split of itself and the new group. */
function wrapTarget(layout: SplitLayout, targetGroupId: string, added: LayoutGroup, direction: SplitDirection, before: boolean): [SplitLayout, LayoutNode] {
  const [splitId, next] = allocate(layout, 's')
  const current = findGroup(layout, targetGroupId)!
  const split: LayoutSplit = {
    type: 'split',
    id: splitId,
    direction,
    children: before ? [added, current] : [current, added],
    sizes: [0.5, 0.5],
  }
  return [next, mapNodes(layout.root!, (node) => (node === current ? split : node))]
}

/** Sets a split's child sizes (normalized). Arranges the layout. */
export function setSplitSizes(layout: SplitLayout, splitId: string, sizes: readonly number[]): SplitLayout {
  const split = findSplit(layout, splitId)
  if (!split || !layout.root || sizes.length !== split.children.length) return layout
  const normalized = normalizeSizes(sizes, split.children.length)
  if (!layout.auto && normalized.every((size, index) => Math.abs(size - split.sizes[index]) < 1e-9)) return layout
  const root = mapNodes(layout.root, (node) => (node === split ? { ...split, sizes: normalized } : node))
  return { ...layout, root, auto: false }
}

/**
 * setSplitSizes for a split some of whose children are folded off screen: `childIds` are the
 * ones shown, `sizes` their new shares of the space they hold between them. Folded children
 * keep their stored share, so they come back where they were.
 */
export function setVisibleSplitSizes(layout: SplitLayout, splitId: string, childIds: readonly string[], sizes: readonly number[]): SplitLayout {
  const split = findSplit(layout, splitId)
  if (!split || childIds.length !== sizes.length) return layout
  const indices = childIds.map((id) => split.children.findIndex((child) => child.id === id))
  if (indices.some((index) => index < 0)) return layout
  const held = indices.reduce((sum, index) => sum + split.sizes[index], 0)
  const shown = normalizeSizes(sizes, sizes.length)
  const next = [...split.sizes]
  indices.forEach((index, position) => { next[index] = shown[position] * held })
  return setSplitSizes(layout, splitId, next)
}

export function equalizeSplit(layout: SplitLayout, splitId: string): SplitLayout {
  const split = findSplit(layout, splitId)
  return split ? setSplitSizes(layout, splitId, normalizeSizes([], split.children.length)) : layout
}

/**
 * Moves the handle between children `index` and `index + 1` by `delta` (a fraction of the
 * split), clamped so neither falls below its minimum fraction. Pure size arithmetic for
 * setSplitSizes; the other children never move.
 */
export function moveHandle(sizes: readonly number[], index: number, delta: number, minimums: readonly number[] = []): number[] {
  if (index < 0 || index >= sizes.length - 1 || !Number.isFinite(delta)) return [...sizes]
  const pair = sizes[index] + sizes[index + 1]
  const minBefore = Math.min(minimums[index] ?? 0, pair / 2)
  const minAfter = Math.min(minimums[index + 1] ?? 0, pair / 2)
  const before = Math.max(minBefore, Math.min(pair - minAfter, sizes[index] + delta))
  const next = [...sizes]
  next[index] = before
  next[index + 1] = pair - before
  return next
}

/** Keeps only the sessions `keep` accepts (hydration against the live session list). File tabs are
 * not sessions and always stay, unless the chat they sat beside is pruned. */
export function pruneSessions(layout: SplitLayout, keep: (sessionId: string) => boolean): SplitLayout {
  const doomed = groupsOf(layout).flatMap((g) => g.tabs).filter((id) => !isFileTabId(id) && !keep(id))
  const pruned = doomed.reduce(closeSession, layout)
  return { ...pruned, focusHistory: pruned.focusHistory.filter((id) => isFileTabId(id) || keep(id)) }
}

/**
 * Closes least-recently-focused groups until at most `cap` remain, never the focused group or
 * one holding a protected session (the drop target, so a drop cannot evict the pane it split).
 * A group's recency is that of its most recently focused tab. Mirrors applyWorkingSetCap, per
 * group: tabs share their group's pane, so only groups spend viewport capacity.
 */
export function evictToCap(layout: SplitLayout, cap: number, protectedIds: readonly string[] = []): SplitLayout {
  const limit = Math.max(0, Math.floor(cap))
  let next = layout
  const recency = (g: LayoutGroup) => Math.max(...g.tabs.map((id) => next.focusHistory.indexOf(id)))
  while (groupsOf(next).length > limit) {
    // The layout's last chat group stays: closing it would close every file pane with it (withRoot).
    const chatGroups = groupsOf(next).filter((g) => g.tabs.some((id) => !isFileTabId(id)))
    const evictable = groupsOf(next).filter((g) => chatGroups.length > 1 || g !== chatGroups[0])
    const candidates = evictable
      .filter((g) => g.id !== next.focusedGroupId && !g.tabs.some((id) => protectedIds.includes(id)))
      .sort((a, b) => recency(a) - recency(b))
    const fallback = evictable.filter((g) => g.id !== next.focusedGroupId).sort((a, b) => recency(a) - recency(b))
    const victim = candidates[0] ?? fallback[0] ?? (limit === 0 ? groupsOf(next)[0] : undefined)
    if (!victim) break
    next = closeGroup(next, victim.id)
  }
  return next
}
