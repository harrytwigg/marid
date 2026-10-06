import type { SplitHandle } from './layout/split-geometry'

/** The desktop chat list's width: how wide, what it may be dragged to, and where it is kept. */
export const SIDEBAR_WIDTH_STORAGE_KEY = 'jinn-chat-sidebar-width'
export const DEFAULT_SIDEBAR_WIDTH = 280
/** The narrowest the list may sit while open. The control row (view switch, new, search, select)
 * needs about 265px on one line; below that it wraps its actions to a second line rather than
 * clipping the last icon (chat-sidebar.tsx), so the list can go this narrow. */
export const MIN_SIDEBAR_WIDTH = 160
export const MAX_SIDEBAR_WIDTH = 480
/** A drag released at or below this width shuts the list (the collapse gesture) rather than
 * setting a width; dragging back out reopens it. The 120-to-MIN_SIDEBAR_WIDTH band is the snap
 * zone, and a release inside it resolves up to MIN_SIDEBAR_WIDTH, so the not-quite-wide-enough
 * value never persists. Measured in the browser against the old 268px floor. */
export const COLLAPSE_SIDEBAR_WIDTH = 120
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

/** True when a width is at or below the collapse threshold: a drag ending there shuts the list
 * instead of setting a width. Non-finite input is not a collapse, so a missing value falls back
 * to the width rules rather than shutting the list. */
export function collapsesSidebar(width: number): boolean {
  return Number.isFinite(width) && width <= COLLAPSE_SIDEBAR_WIDTH
}

export type SidebarWidthResolution =
  | { collapsed: true }
  | { collapsed: false; width: number }

/** Resolves a dragged width: at or below the threshold it collapses, otherwise it is the width
 * held inside the open range. The one place the two outcomes are decided, shared by the drag
 * commit and its tests. */
export function resolveSidebarWidth(width: number, viewportWidth: number): SidebarWidthResolution {
  if (collapsesSidebar(width)) return { collapsed: true }
  return { collapsed: false, width: clampSidebarWidth(width, viewportWidth) }
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
 * fractions are of the row beside the ribbon. moveHandle never lets a side pass half the pair.
 * The drag floor is zero, not the open minimum, so the edge can be pulled down into the collapse
 * zone below MIN_SIDEBAR_WIDTH; the width is resolved (resolveSidebarWidth) on release.
 */
export function sidebarHandle(width: number, viewportWidth: number, height: number): SplitHandle {
  const { max } = sidebarWidthBounds(viewportWidth)
  const extent = Math.max(1, viewportWidth - NAV_RIBBON_WIDTH)
  const list = Math.min(Math.max(width, 0), max) / extent
  return {
    splitId: 'sidebar',
    index: 0,
    direction: 'row',
    rect: { left: width, top: 0, width: 0, height },
    sizes: [list, 1 - list],
    extent,
    minimums: [0, 0],
    childIds: ['list', 'thread'],
  }
}

/** The width the handle's `sizes` describe before the open minimum lifts it: what the collapse
 * decision reads, so a drag into the snap zone is visible as such. Capped at the maximum and
 * floored at zero; garbage degrades to the default. */
export function rawWidthFromSizes(sizes: readonly number[], viewportWidth: number): number {
  const { max } = sidebarWidthBounds(viewportWidth)
  const width = (sizes[0] ?? 0) * Math.max(1, viewportWidth - NAV_RIBBON_WIDTH)
  return Number.isFinite(width) ? Math.round(Math.min(Math.max(0, width), max)) : DEFAULT_SIDEBAR_WIDTH
}
