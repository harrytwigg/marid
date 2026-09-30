import type { SplitHandle } from './layout/split-geometry'

/** The desktop chat list's width: how wide, what it may be dragged to, and where it is kept. */
export const SIDEBAR_WIDTH_STORAGE_KEY = 'jinn-chat-sidebar-width'
export const DEFAULT_SIDEBAR_WIDTH = 280
/** The list's control row (view switch, new, search, select) is about 265px wide; narrower, its
 * last icon is clipped. Measured in the browser: 252 clips it, 268 shows it whole. */
export const MIN_SIDEBAR_WIDTH = 268
export const MAX_SIDEBAR_WIDTH = 480
/** The nav ribbon beside the list (pill-nav.tsx, w-14). */
export const NAV_RIBBON_WIDTH = 56
/** What the thread keeps however wide the list is dragged: above the panes' own floor
 * (MIN_PANE_WIDTH) so a single pane's composer never clips. */
export const MIN_THREAD_WIDTH = 420

type WidthStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** The range the list may take in a window `viewportWidth` wide. The thread's floor wins over
 * the maximum, and the minimum over both, so a narrow window never yields an empty range. */
export function sidebarWidthBounds(viewportWidth: number): { min: number; max: number } {
  const room = viewportWidth - NAV_RIBBON_WIDTH - MIN_THREAD_WIDTH
  return { min: MIN_SIDEBAR_WIDTH, max: Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, room)) }
}

export function clampSidebarWidth(width: number, viewportWidth: number): number {
  const { min, max } = sidebarWidthBounds(viewportWidth)
  return Number.isFinite(width) ? Math.round(Math.max(min, Math.min(max, width))) : DEFAULT_SIDEBAR_WIDTH
}

/** The saved width, or null when there is none or it is not a plausible number: a hand-edited
 * value degrades to the default rather than breaking the layout. */
export function loadSidebarWidth(storage: Pick<Storage, 'getItem'> = localStorage): number | null {
  try {
    const raw = storage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)
    const width = raw === null ? Number.NaN : Number(raw)
    return Number.isFinite(width) && width > 0 ? width : null
  } catch {
    return null
  }
}

/** null forgets the saved width, so the default applies again. */
export function saveSidebarWidth(width: number | null, storage: WidthStorage = localStorage): void {
  try {
    if (width === null) storage.removeItem(SIDEBAR_WIDTH_STORAGE_KEY)
    else storage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width))
  } catch { /* storage unavailable: the width lasts for the session */ }
}

/**
 * The list's edge as a two-child split of the row (list | thread), so the split panes' own
 * SplitHandleBar drags it: same pointer capture, keyboard steps, reset and affordance. The
 * fractions are of the row beside the ribbon. moveHandle never lets a side pass half the pair,
 * so it enforces only the list's minimum; widthFromSizes applies the maximum.
 */
export function sidebarHandle(width: number, viewportWidth: number, height: number): SplitHandle {
  const { min, max } = sidebarWidthBounds(viewportWidth)
  const extent = Math.max(1, viewportWidth - NAV_RIBBON_WIDTH)
  const list = Math.min(Math.max(width, min), max) / extent
  return {
    splitId: 'sidebar',
    index: 0,
    direction: 'row',
    rect: { left: width, top: 0, width: 0, height },
    sizes: [list, 1 - list],
    extent,
    minimums: [min / extent, 0],
    childIds: ['list', 'thread'],
  }
}

/** The list's width after the handle moved the split to `sizes`, held inside the bounds. */
export function widthFromSizes(sizes: readonly number[], viewportWidth: number): number {
  return clampSidebarWidth((sizes[0] ?? 0) * Math.max(1, viewportWidth - NAV_RIBBON_WIDTH), viewportWidth)
}
