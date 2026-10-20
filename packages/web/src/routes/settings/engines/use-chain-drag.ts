import { useCallback, useMemo, useRef, useState } from "react"

/* Pointer reorder for one fallback chain, in the board's hand-rolled idiom
 * (`routes/todos/board/use-board-drag.ts`): window listeners, a travel
 * threshold so a click on a row's own controls still lands, and Escape to cancel. A chain is a list rather than a board, so the geometry is
 * one dimension and is measured once on lift: the rows move by transform, which
 * leaves the slots the pointer is tested against exactly where they were.
 *
 * On a touch screen a row is part of the page's scroll: only the grip takes the
 * pointer (`touch-action: none` is on it alone), so a swipe that starts on a row
 * still scrolls, and a drag that starts on the grip lifts at once.
 *
 * Dragging is one of two ways to reorder. The move buttons on each row are the
 * other, and they are the one that works with no pointer at all. */

const LIFT_THRESHOLD_PX = 5

export interface ChainDragState {
  from: number
  /** Slot the lifted row would land in, counted with itself taken out. */
  to: number
  /** How far the lifted row has travelled from its own slot. */
  offsetY: number
  /** Distance between two slots, by which a stepped-over row shifts. */
  step: number
}

/** How far row `index` shifts to open the gap the lifted row is heading for. */
export function rowShift(drag: ChainDragState | null, index: number): number {
  if (!drag || index === drag.from) return 0
  if (drag.to > drag.from && index > drag.from && index <= drag.to) return -drag.step
  if (drag.to < drag.from && index >= drag.to && index < drag.from) return drag.step
  return 0
}

/** The slot the pointer is over, counted with the lifted row taken out. */
function slotUnder(rects: DOMRect[], from: number, y: number): number {
  let slot = 0
  rects.forEach((rect, index) => {
    if (index !== from && y > rect.top + rect.height / 2) slot++
  })
  return slot
}

/** Every window listener one session needs, all released by the one abort. */
function listenForSession(
  session: AbortController,
  onMove: (event: PointerEvent) => void,
  end: (commit: boolean) => void,
): void {
  const on = (type: string, handler: EventListener) =>
    window.addEventListener(type, handler, { passive: false, signal: session.signal })
  on("pointermove", onMove as EventListener)
  on("pointerup", () => end(true))
  on("pointercancel", () => end(false))
  on("keydown", (event) => { if ((event as KeyboardEvent).key === "Escape") end(false) })
}

/** One pointer session: holds the window from press to release, then says
 *  whether the release was a drop or an abandonment. */
function beginDrag(
  event: React.PointerEvent,
  from: number,
  rects: DOMRect[],
  update: (state: ChainDragState) => void,
  finish: (commit: boolean) => void,
): void {
  const step = rects[1].top - rects[0].top
  const startX = event.clientX
  const startY = event.clientY
  const session = new AbortController()
  let lifted = false

  const end = (commit: boolean) => {
    session.abort()
    finish(commit)
  }

  const onMove = (e: PointerEvent) => {
    if (!lifted) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < LIFT_THRESHOLD_PX) return
      lifted = true
    }
    e.preventDefault()
    update({ from, to: slotUnder(rects, from, e.clientY), offsetY: e.clientY - startY, step })
  }

  listenForSession(session, onMove, end)
}

export function useChainDrag(onReorder: (from: number, to: number) => void) {
  const [drag, setDrag] = useState<ChainDragState | null>(null)
  const dragRef = useRef<ChainDragState | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const onReorderRef = useRef(onReorder)
  onReorderRef.current = onReorder

  const reducedMotion = useMemo(
    () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  )

  const update = useCallback((state: ChainDragState) => {
    dragRef.current = state
    setDrag(state)
  }, [])

  const finish = useCallback((commit: boolean) => {
    const state = dragRef.current
    dragRef.current = null
    setDrag(null)
    if (state && commit && state.to !== state.from) onReorderRef.current(state.from, state.to)
  }, [])

  const liftPointerDown = useCallback((event: React.PointerEvent, from: number) => {
    if (event.button !== 0 && event.pointerType !== "touch") return
    const target = event.target as HTMLElement
    // The row's buttons and selects own their own pointer, and a touch on the row is a scroll.
    if (target.closest("button, select, input")) return
    if (event.pointerType === "touch" && !target.closest("[data-chain-grip]")) return
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-chain-row]") ?? [])
    if (rows.length < 2) return
    beginDrag(event, from, rows.map((row) => row.getBoundingClientRect()), update, finish)
  }, [update, finish])

  return { drag, listRef, liftPointerDown, reducedMotion }
}
