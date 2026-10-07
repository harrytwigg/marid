import { cellRectForIndex } from '../grid-cells'
import { layoutFor } from '../grid-layout'
import {
  groupIdsByPaneKey,
  groupsOf,
  materializeLayout,
  workingSetFromLayout,
  type LayoutGroup,
  type LayoutNode,
  type SplitDirection,
  type SplitLayout,
} from './split-layout'
import { isChatTabId } from './tab-kind'

/**
 * Where every pane and splitter sits, as one pure function of the layout and the grid's box.
 * The renderer positions panes from it and the drop preview projects the post-drop layout
 * through it, so a preview and the pane that lands cannot disagree.
 */

export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

export interface SplitMetrics {
  /** The grid's inset and the gutter between panes: the upstream grid's --space-2. */
  padding: number
  gap: number
}

/** Below these a chat pane stops being usable. The width is the upstream grid's own pane floor
 * (grid-layout.ts MIN_PANE_WIDTH): narrower, the composer's send button is clipped. The height
 * leaves a few transcript lines between the title bar and the composer. */
export const MIN_PANE_WIDTH = 340
export const MIN_PANE_HEIGHT = 240

export interface PaneBox {
  /** The grid key the pane renders under (a session id, the route pane, or a picker). */
  key: string
  /** The group it shows, or null for a pane the layout does not hold (picker, composer). */
  groupId: string | null
  rect: Rect
  /** Mounted but not placed: the window is too small for it (see arrangedGeometry). */
  folded: boolean
}

export interface SplitHandle {
  splitId: string
  /** The gutter between children `index` and `index + 1`. */
  index: number
  direction: SplitDirection
  rect: Rect
  sizes: number[]
  /** Pixels the split's children share along its axis, gutters excluded. */
  extent: number
  /** Each child's minimum as a fraction of `extent`. */
  minimums: number[]
  /** The split's children on screen, in order: all of them unless some are folded away, which
   * is how a resize maps back onto the stored split (setVisibleSplitSizes). */
  childIds: string[]
}

export interface SplitGeometry {
  panes: PaneBox[]
  handles: SplitHandle[]
  /** The layout the handles belong to: the materialized form of an auto layout. A resize
   * commits against this, so its split ids resolve. */
  handleLayout: SplitLayout
  columns: number
  rows: number
}

export interface GeometryInput {
  layout: SplitLayout
  /** Grid keys in render order, exactly as the grid receives them. */
  keys: readonly string[]
  /** Which session a key shows; keys that resolve to no group in the layout are transient. */
  sessionForKey: (key: string) => string | null
  box: Rect
  viewport: { width: number; height: number }
  metrics: SplitMetrics
}

function inset(box: Rect, by: number): Rect {
  return {
    left: box.left + by,
    top: box.top + by,
    width: Math.max(0, box.width - by * 2),
    height: Math.max(0, box.height - by * 2),
  }
}

function minimumExtent(node: LayoutNode, axis: SplitDirection, gap: number): number {
  if (node.type === 'group') return axis === 'row' ? MIN_PANE_WIDTH : MIN_PANE_HEIGHT
  const childMinimums = node.children.map((child) => minimumExtent(child, axis, gap))
  return node.direction === axis
    ? childMinimums.reduce((sum, value) => sum + value, 0) + gap * (node.children.length - 1)
    : Math.max(...childMinimums)
}

/**
 * Pixel extents for `sizes` of `available`, lifting any child under its minimum and taking the
 * difference from the others in proportion. When the minimums cannot all fit (a window far
 * narrower than the layout), everything scales down together instead: the fallback the
 * viewport cap (grid-layout.ts capForViewport) folds panes away from long before it matters.
 */
export function fitExtents(sizes: readonly number[], available: number, minimums: readonly number[]): number[] {
  const floor = minimums.reduce((sum, value) => sum + value, 0)
  if (floor >= available) {
    return floor > 0 ? minimums.map((value) => (value / floor) * available) : sizes.map((size) => size * available)
  }
  const pinned = new Set<number>()
  for (;;) {
    const freeShare = sizes.reduce((sum, size, index) => (pinned.has(index) ? sum : sum + size), 0)
    const freeSpace = available - [...pinned].reduce((sum, index) => sum + minimums[index], 0)
    const extents = sizes.map((size, index) => (pinned.has(index) ? minimums[index] : (size / freeShare) * freeSpace))
    const under = extents.findIndex((value, index) => !pinned.has(index) && value < minimums[index] - 1e-6)
    if (under < 0) return extents
    pinned.add(under)
  }
}

interface Placement {
  groups: Map<string, Rect>
  handles: SplitHandle[]
}

function placeNode(node: LayoutNode, box: Rect, gap: number, out: Placement): void {
  if (node.type === 'group') {
    out.groups.set(node.id, box)
    return
  }
  const row = node.direction === 'row'
  const length = row ? box.width : box.height
  const extent = Math.max(0, length - gap * (node.children.length - 1))
  const minimumPx = node.children.map((child) => minimumExtent(child, node.direction, gap))
  const extents = fitExtents(node.sizes, extent, minimumPx)
  let cursor = row ? box.left : box.top
  node.children.forEach((child, index) => {
    const childBox = row
      ? { left: cursor, top: box.top, width: extents[index], height: box.height }
      : { left: box.left, top: cursor, width: box.width, height: extents[index] }
    placeNode(child, childBox, gap, out)
    cursor += extents[index]
    if (index === node.children.length - 1) return
    out.handles.push({
      splitId: node.id,
      index,
      direction: node.direction,
      rect: row
        ? { left: cursor, top: box.top, width: gap, height: box.height }
        : { left: box.left, top: cursor, width: box.width, height: gap },
      // What is on screen, not what is stored: a child lifted to its minimum drags from there.
      sizes: extents.map((value) => (extent > 0 ? value / extent : 0)),
      extent,
      minimums: minimumPx.map((value) => (extent > 0 ? value / extent : 0)),
      childIds: node.children.map((child) => child.id),
    })
    cursor += gap
  })
}

function autoColumns(count: number, viewport: GeometryInput['viewport']): { columns: number; rows: number } {
  return layoutFor(count, viewport.width, viewport.height)
}

/** Keys in render order, each with the group it shows (null when the layout holds none). */
function resolveKeys(input: GeometryInput): Array<{ key: string; groupId: string | null }> {
  const groupByPaneKey = groupIdsByPaneKey(input.layout)
  return input.keys.map((key) => {
    // A pane with no chat is keyed by its own tab id (a document's, a new chat's), which sessionForKey
    // (chats and the route composer) never maps.
    const paneKey = isChatTabId(key) ? input.sessionForKey(key) : key
    return { key, groupId: paneKey ? groupByPaneKey.get(paneKey) ?? null : null }
  })
}

/** The upstream grid, cell for cell: an unarranged layout renders exactly as before. */
function autoGeometry(input: GeometryInput, resolved: ReturnType<typeof resolveKeys>): SplitGeometry {
  const { columns, rows } = autoColumns(resolved.length, input.viewport)
  const panes = resolved.map(({ key, groupId }, index) => ({
    key,
    groupId,
    folded: false,
    rect: cellRectForIndex(index, resolved.length, input.box, { w: input.viewport.width, h: input.viewport.height }, input.metrics),
  }))
  // Handles come from the layout a resize would materialize. With a transient pane mounted, or
  // groups folded away by a narrower window, the cells no longer line up with the groups, so
  // there is nothing honest to drag.
  const aligned = resolved.every((entry) => entry.groupId !== null) && resolved.length === groupsOf(input.layout).length
  const handleLayout = materializeLayout(input.layout, columns)
  const handles = !aligned || resolved.length < 2 || !handleLayout.root
    ? []
    : arrangedPlacement(handleLayout.root, input).handles
  return { panes, handles, handleLayout, columns, rows }
}

function arrangedPlacement(root: LayoutNode, input: GeometryInput): Placement {
  const out: Placement = { groups: new Map(), handles: [] }
  placeNode(root, inset(input.box, input.metrics.padding), input.metrics.gap, out)
  return out
}

/**
 * Groups placed by a pruned tree, least recently focused first; the focused one never. The group
 * holding the route's chat (the working set's focused one) goes last: with a pane that has no chat
 * focused (a document, a new chat), that chat is the one the operator is still working in, so the
 * others fold first.
 */
function foldCandidates(layout: SplitLayout, root: LayoutNode): string[] {
  const route = workingSetFromLayout(layout).focusedId
  const recency = (group: LayoutGroup) => (route && group.tabs.includes(route)
    ? Number.MAX_SAFE_INTEGER
    : layout.focusHistory.indexOf(group.activeTab))
  const visible: LayoutGroup[] = []
  const walk = (node: LayoutNode) => (node.type === 'group' ? visible.push(node) : node.children.forEach(walk))
  walk(root)
  return visible
    .filter((group) => group.id !== layout.focusedGroupId)
    .sort((a, b) => recency(a) - recency(b))
    .map((group) => group.id)
}

/**
 * The mounted groups' tree, with least recently focused groups folded away until every pane
 * gets its minimum: a window too small for the arrangement hides panes (still mounted, so
 * nothing reloads) rather than squashing them past usefulness, and growing it back restores
 * them. The focused group always stays.
 */
function fitToBox(layout: SplitLayout, mounted: Set<string>, box: { width: number; height: number }, gap: number): LayoutNode | null {
  let root = pruneToMounted(layout.root, mounted, true)
  while (root && root.type === 'split'
    && (minimumExtent(root, 'row', gap) > box.width || minimumExtent(root, 'column', gap) > box.height)) {
    const victim = foldCandidates(layout, root)[0]
    if (!victim) break
    mounted.delete(victim)
    root = pruneToMounted(layout.root, mounted, true)
  }
  return root
}

/**
 * An arranged layout. Keys the layout does not hold (the picker, a sessionless composer) take
 * a column on the right, the way "Open beside" reads.
 */
function arrangedGeometry(input: GeometryInput, resolved: ReturnType<typeof resolveKeys>): SplitGeometry {
  const mounted = new Set(resolved.flatMap((entry) => (entry.groupId ? [entry.groupId] : [])))
  const transient = resolved.filter((entry) => entry.groupId === null)
  const inner = inset(input.box, input.metrics.padding)
  const gap = input.metrics.gap
  const hasGroups = mounted.size > 0
  const sideShare = hasGroups && transient.length ? 1 / 3 : 1
  const sideWidth = transient.length ? (inner.width - gap * (hasGroups ? transient.length : transient.length - 1)) * sideShare : 0
  const mainWidth = hasGroups ? (transient.length ? inner.width - sideWidth - gap * transient.length : inner.width) : 0
  const root = fitToBox(input.layout, mounted, { width: mainWidth, height: inner.height }, gap)
  const out: Placement = { groups: new Map(), handles: [] }
  if (root) placeNode(root, { ...inner, width: mainWidth }, gap, out)
  const panes: PaneBox[] = resolved.map(({ key, groupId }) => {
    if (groupId) {
      const rect = out.groups.get(groupId)
      return { key, groupId, folded: !rect, rect: rect ?? { left: inner.left, top: inner.top, width: 0, height: 0 } }
    }
    const slot = transient.findIndex((entry) => entry.key === key)
    const width = sideWidth / transient.length
    const left = inner.left + (hasGroups ? mainWidth + gap : 0) + slot * (width + gap)
    return { key, groupId: null, folded: false, rect: { left, top: inner.top, width, height: inner.height } }
  })
  return { panes, handles: out.handles, handleLayout: input.layout, columns: 0, rows: 0 }
}

/**
 * The layout's tree with only the mounted groups: a narrowing window folds panes away
 * (grid-layout.ts overflowForViewport, and fitToBox) and their space goes to their siblings.
 * A split left with one child stays a split of one, so every split on screen keeps its stored
 * id and its children stay a subset of the stored ones; only the root is unwrapped.
 */
function pruneToMounted(node: LayoutNode | null, mounted: ReadonlySet<string>, isRoot = false): LayoutNode | null {
  if (!node) return null
  if (node.type === 'group') return mounted.has(node.id) ? node : null
  const kept = node.children.flatMap((child, index) => {
    const pruned = pruneToMounted(child, mounted)
    return pruned ? [{ child: pruned, size: node.sizes[index] }] : []
  })
  if (kept.length === 0) return null
  if (kept.length === 1 && isRoot) return unwrap(kept[0].child)
  if (kept.length === node.children.length && kept.every((entry, index) => entry.child === node.children[index])) return node
  const total = kept.reduce((sum, entry) => sum + entry.size, 0)
  return { ...node, children: kept.map((entry) => entry.child), sizes: kept.map((entry) => entry.size / total) }
}

function unwrap(node: LayoutNode): LayoutNode {
  return node.type === 'split' && node.children.length === 1 ? unwrap(node.children[0]) : node
}

export function splitGeometry(input: GeometryInput): SplitGeometry {
  const resolved = resolveKeys(input)
  if (resolved.length <= 1) {
    return {
      panes: resolved.map(({ key, groupId }) => ({ key, groupId, folded: false, rect: { ...input.box } })),
      handles: [],
      handleLayout: input.layout,
      columns: resolved.length,
      rows: resolved.length,
    }
  }
  return input.layout.auto ? autoGeometry(input, resolved) : arrangedGeometry(input, resolved)
}

export type SplitDropRegion = 'left' | 'right' | 'top' | 'bottom' | 'center' | 'end'

export interface SplitDropHit {
  region: SplitDropRegion
  /** The pane under the pointer, or null for 'end' (inside the grid, outside every pane). */
  key: string | null
  groupId: string | null
}

function contains(point: { x: number; y: number }, rect: Rect): boolean {
  return point.x >= rect.left && point.x < rect.left + rect.width && point.y >= rect.top && point.y < rect.top + rect.height
}

/**
 * The same edge quarters as grid-placement.ts placementForPointer, so a pointer lands in the same
 * region under either grid; its middle, which the flat grid had to call left or right, is the
 * group itself here.
 */
export function regionInPane(point: { x: number; y: number }, rect: Rect): Exclude<SplitDropRegion, 'end'> {
  const x = (point.x - rect.left) / rect.width
  const y = (point.y - rect.top) / rect.height
  const horizontal = edge(x, 'left', 'right')
  const vertical = edge(y, 'top', 'bottom')
  if (horizontal && vertical) {
    const horizontalDistance = horizontal === 'left' ? x : 1 - x
    const verticalDistance = vertical === 'top' ? y : 1 - y
    return horizontalDistance <= verticalDistance ? horizontal : vertical
  }
  return horizontal ?? vertical ?? 'center'
}

function edge<Low extends string, High extends string>(fraction: number, low: Low, high: High): Low | High | null {
  if (fraction < 0.25) return low
  return fraction >= 0.75 ? high : null
}

/** A pointer this close to a pane, in a gutter or the grid's inset, is aimed at that pane. */
const GUTTER_REACH = 16

function distance(point: { x: number; y: number }, rect: Rect): number {
  const dx = Math.max(rect.left - point.x, 0, point.x - (rect.left + rect.width))
  const dy = Math.max(rect.top - point.y, 0, point.y - (rect.top + rect.height))
  return Math.hypot(dx, dy)
}

export interface DropPane {
  key: string
  groupId: string | null
  rect: Rect
  /** Where the regions are measured, when that is not the whole pane: the part above the
   * composer. Drops on the composer are refused (chat-session-dnd.ts isComposerDropTarget),
   * so measured on the whole pane its bottom quarter would be almost all composer and a
   * bottom split out of reach on any stacked pane. */
  hitRect?: Rect
}

/**
 * 'end' is reserved for real empty space (the auto grid's trailing cell). A pointer in a gutter
 * snaps to the nearest pane instead, clamped onto its edge, so dropping between two panes splits
 * one of them rather than appending somewhere else.
 */

export function splitDropForPointer(
  point: { x: number; y: number },
  panes: readonly DropPane[],
  gridRect: Rect,
): SplitDropHit | null {
  if (!contains(point, gridRect)) return null
  const nearest = panes
    .filter((entry) => entry.rect.width > 0 && entry.rect.height > 0)
    .map((entry) => ({ entry, gap: distance(point, entry.rect) }))
    .sort((a, b) => a.gap - b.gap)[0]
  if (!nearest || nearest.gap > GUTTER_REACH) return { region: 'end', key: null, groupId: null }
  const rect = nearest.entry.hitRect ?? nearest.entry.rect
  const clamped = {
    x: Math.min(Math.max(point.x, rect.left), rect.left + rect.width - 1e-6),
    y: Math.min(Math.max(point.y, rect.top), rect.top + rect.height - 1e-6),
  }
  return { region: regionInPane(clamped, rect), key: nearest.entry.key, groupId: nearest.entry.groupId }
}
