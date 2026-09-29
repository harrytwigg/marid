import {
  emptySplitLayout,
  normalizeLayout,
  normalizeSizes,
  type LayoutGroup,
  type LayoutNode,
  type SplitLayout,
} from './split-layout'

/** Its own key: the upstream working set keeps `jinn-chat-working-set`, which this layout also
 * writes (as its projection) so the two never disagree about membership. */
export const SPLIT_LAYOUT_STORAGE_KEY = 'jinn-chat-split-layout'

interface PersistedSplitLayout extends SplitLayout {
  version: 1
}

type LayoutStorage = Pick<Storage, 'getItem' | 'setItem'>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** previewTab survives only when it names one of the group's tabs. */
function withRevivedPreview(group: LayoutGroup, previewTab: unknown): LayoutGroup {
  return typeof previewTab === 'string' && group.tabs.includes(previewTab) ? { ...group, previewTab } : group
}

function reviveGroup(value: Record<string, unknown>, id: string, seenSessions: Set<string>): LayoutNode | null {
  const tabs: string[] = []
  for (const tab of Array.isArray(value.tabs) ? value.tabs : []) {
    const sessionId = typeof tab === 'string' ? tab.trim() : ''
    if (!sessionId || seenSessions.has(sessionId)) continue
    seenSessions.add(sessionId)
    tabs.push(sessionId)
  }
  if (tabs.length === 0) return null
  const activeTab = typeof value.activeTab === 'string' && tabs.includes(value.activeTab) ? value.activeTab : tabs[0]
  return withRevivedPreview({ type: 'group', id, tabs, activeTab }, value.previewTab)
}

function reviveSplit(value: Record<string, unknown>, id: string, seenSessions: Set<string>, seenIds: Set<string>): LayoutNode | null {
  if (value.direction !== 'row' && value.direction !== 'column') return null
  const rawSizes = Array.isArray(value.sizes) ? value.sizes : []
  const children: LayoutNode[] = []
  const sizes: number[] = []
  ;(Array.isArray(value.children) ? value.children : []).forEach((child, index) => {
    const revived = reviveNode(child, seenSessions, seenIds)
    if (!revived) return
    children.push(revived)
    sizes.push(typeof rawSizes[index] === 'number' ? rawSizes[index] : Number.NaN)
  })
  if (children.length <= 1) return children[0] ?? null
  return { type: 'split', id, direction: value.direction, children, sizes: normalizeSizes(sizes, children.length) }
}

/**
 * Rebuilds a node from untrusted JSON. A session may appear in only one tab across the whole
 * tree (it mounts once), so later duplicates are dropped; malformed nodes are dropped with
 * them, and sizes that do not add up are evened out. normalizeLayout then restores the
 * structural invariants the ops rely on.
 */
function reviveNode(value: unknown, seenSessions: Set<string>, seenIds: Set<string>): LayoutNode | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id || seenIds.has(value.id)) return null
  seenIds.add(value.id)
  if (value.type === 'group') return reviveGroup(value, value.id, seenSessions)
  return value.type === 'split' ? reviveSplit(value, value.id, seenSessions, seenIds) : null
}

function maxIdSuffix(node: LayoutNode | null): number {
  if (!node) return 0
  const own = Number.parseInt(node.id.slice(1), 10)
  const mine = Number.isFinite(own) ? own : 0
  return node.type === 'group' ? mine : Math.max(mine, ...node.children.map(maxIdSuffix))
}

export function serializeSplitLayout(layout: SplitLayout): string {
  const persisted: PersistedSplitLayout = { version: 1, ...layout }
  return JSON.stringify(persisted)
}

export function restoreSplitLayout(raw: string | null): SplitLayout {
  if (!raw) return emptySplitLayout()
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || parsed.version !== 1) return emptySplitLayout()
    const root = reviveNode(parsed.root, new Set(), new Set())
    const layout: SplitLayout = {
      root,
      auto: parsed.auto !== false,
      focusedGroupId: typeof parsed.focusedGroupId === 'string' ? parsed.focusedGroupId : null,
      focusHistory: Array.isArray(parsed.focusHistory)
        ? parsed.focusHistory.filter((id): id is string => typeof id === 'string')
        : [],
      // Never below what the tree already uses, or a new group could reuse a live id.
      nextId: Math.max(
        typeof parsed.nextId === 'number' && Number.isInteger(parsed.nextId) ? parsed.nextId : 1,
        maxIdSuffix(root) + 1,
      ),
    }
    return normalizeLayout(layout)
  } catch {
    return emptySplitLayout()
  }
}

export function persistSplitLayout(storage: LayoutStorage, layout: SplitLayout): void {
  try {
    storage.setItem(SPLIT_LAYOUT_STORAGE_KEY, serializeSplitLayout(layout))
  } catch {
    // Private browsing and quota failures must not make chat navigation fail.
  }
}

export function loadSplitLayout(storage: Pick<Storage, 'getItem'>): SplitLayout {
  try {
    return restoreSplitLayout(storage.getItem(SPLIT_LAYOUT_STORAGE_KEY))
  } catch {
    return emptySplitLayout()
  }
}
