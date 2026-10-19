import { useEffect, useState, type RefObject } from "react"

/* The board on a phone: the same columns as the desktop, swiped one at a time
 * (84vw each, so the next one peeks in), with the grouped list one tap away.
 * What is shared between the switch, the position marker and the page lives here. */

/** The one breakpoint the Todos dash reads: below it the columns are swiped (or
 *  the grouped list shown), above it they sit side by side. No `window` — SSR,
 *  jsdom — reads as desktop. */
const MOBILE_QUERY = "(max-width: 700px)"
export function useIsBoardMobile(): boolean {
  const [mobile, setMobile] = useState(
    () => typeof window !== "undefined" && (window.matchMedia?.(MOBILE_QUERY).matches ?? false),
  )
  useEffect(() => {
    const query = window.matchMedia?.(MOBILE_QUERY)
    if (!query) return
    const onChange = (event: MediaQueryListEvent) => setMobile(event.matches)
    query.addEventListener("change", onChange)
    return () => query.removeEventListener("change", onChange)
  }, [])
  return mobile
}

export type BoardView = "board" | "list"

/** How a card changes column on a phone. `menu` is the tap "Move to…" action on the
 *  card; `drag` would lift it with a long press, which needs the strip to scroll
 *  itself while a card is held near its edge (the drag hook does not do that yet).
 *  The desktop drags either way. */
export const PHONE_CARD_MOVE = "menu" as "menu" | "drag"

const VIEW_KEY = "jinn-board-phone-view"

/** The view this device last picked; the board until it picks. */
export function loadBoardView(): BoardView {
  try {
    return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "board"
  } catch {
    return "board"
  }
}

export function saveBoardView(view: BoardView): void {
  try {
    localStorage.setItem(VIEW_KEY, view)
  } catch {
    /* a convenience, not state */
  }
}

/** Marks what the strip snaps to: each open column and the Closed one. */
export const SNAP_ATTRIBUTE = "data-board-snap"

export interface ColumnPosition {
  /** 1-based; 0 before anything is measured. */
  index: number
  total: number
}

/** Which column the strip is parked on: the one whose left edge is nearest the
 *  strip's left edge, or the last one once the strip is scrolled to its end (the
 *  last column cannot reach the start). `watch` re-reads when the columns change. */
export function useColumnPosition(scrollRef: RefObject<HTMLElement | null>, active: boolean, watch: unknown): ColumnPosition {
  const [position, setPosition] = useState<ColumnPosition>({ index: 0, total: 0 })
  useEffect(() => {
    const strip = scrollRef.current
    if (!strip || !active) return
    let frame = 0
    const read = () => {
      frame = 0
      const columns = [...strip.querySelectorAll<HTMLElement>(`[${SNAP_ATTRIBUTE}]`)]
      if (columns.length === 0) return setPosition({ index: 0, total: 0 })
      const padding = parseFloat(getComputedStyle(strip).scrollPaddingLeft)
      const origin = strip.getBoundingClientRect().left + (Number.isNaN(padding) ? 0 : padding)
      let nearest = 0
      let best = Infinity
      columns.forEach((column, i) => {
        const gap = Math.abs(column.getBoundingClientRect().left - origin)
        if (gap < best) [nearest, best] = [i, gap]
      })
      const atEnd = strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 2 && strip.scrollWidth > strip.clientWidth
      const next = { index: (atEnd ? columns.length - 1 : nearest) + 1, total: columns.length }
      setPosition((previous) => (previous.index === next.index && previous.total === next.total ? previous : next))
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(read)
    }
    read()
    strip.addEventListener("scroll", schedule, { passive: true })
    window.addEventListener("resize", schedule)
    return () => {
      strip.removeEventListener("scroll", schedule)
      window.removeEventListener("resize", schedule)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [scrollRef, active, watch])
  return position
}
