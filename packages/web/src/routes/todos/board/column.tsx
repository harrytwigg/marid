import { useLayoutEffect, useRef, type ReactNode } from "react"
import { Plus } from "lucide-react"
import type { WorkItemStatusWire } from "@/lib/api"
import { StateCircle } from "../state-glyph"
import { stateKeyOf, STATUS_LABEL } from "@/lib/todos"
import { BOARD_PAGE_SIZE } from "./use-board"
import type { BoardDragState } from "./use-board-drag"

/* Todos v2 slice 6 — one status column (design-doc §2). Sticky header carries
 * the page background (polish law 21) so cards scroll under it; the track is
 *  transparent — cards sit directly on --bg. The `+` lives on To do
 *  only: creation is birth, never a teleport into mid-pipeline. During a drag,
 * an illegal/gated column recedes to 38% and renders no slot. */

/** FLIP the column's cards when the list shifts (slot insertion, drops,
 *  polling moves). Measures previous tops per card id and plays the inversion
 *  as a transform — skipped under reduced motion or where WAAPI is absent
 *  (jsdom).
 *
 *  Tops are read from layout, not from the viewport: a viewport rect also moves
 *  when the reader scrolls, so any re-render after a scroll used to read the
 *  scroll offset as movement and slide every card in from a screen away. That
 *  also expanded the container's scrollHeight for the length of the animation
 *  (2721 → 3606 at 390x844), which is the phantom board scroll anchoring was
 *  chasing to an edge. */
function useColumnFlip(bodyRef: React.RefObject<HTMLDivElement | null>, dep: unknown) {
  const prevTops = useRef(new Map<string, number>())
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
    const next = new Map<string, number>()
    for (const card of el.querySelectorAll<HTMLElement>("[data-board-card]")) {
      const id = card.dataset.boardCard!
      const top = card.offsetTop
      next.set(id, top)
      const prev = prevTops.current.get(id)
      if (!reduced && prev !== undefined && Math.abs(prev - top) > 1 && typeof card.animate === "function") {
        card.animate(
          [{ transform: `translateY(${prev - top}px)` }, { transform: "translateY(0)" }],
          { duration: 200, easing: "cubic-bezier(.34,1.3,.64,1)" },
        )
      }
    }
    prevTops.current = next
  }, [bodyRef, dep])
}

export interface BoardColumnProps {
  status: WorkItemStatusWire
  count: number
  children: ReactNode
  /** Item ids in render order (FLIP dependency). */
  orderKey: string
  onQuickAdd?: () => void
  hasMore: boolean
  remaining: number
  loadMore: () => void
  loadingMore: boolean
  drag: BoardDragState | null
  registerColumn: (status: WorkItemStatusWire) => (el: HTMLElement | null) => void
}

export function BoardColumn({
  status,
  count,
  children,
  orderKey,
  onQuickAdd,
  hasMore,
  remaining,
  loadMore,
  loadingMore,
  drag,
  registerColumn,
}: BoardColumnProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const dimmed = !!drag && !drag.legal.has(status)
  const slotAt = drag && drag.overStatus === status ? drag.overIndex : null
  useColumnFlip(bodyRef, `${orderKey}|${slotAt ?? ""}`)

  const label = STATUS_LABEL[status]
  return (
    <section
      data-testid={`board-column-${status}`}
      data-board-column={status}
      className="flex min-w-0 flex-1 flex-col transition-opacity duration-150 max-[700px]:flex-none"
      style={{
        opacity: dimmed ? 0.38 : undefined,
        flex: drag ? `0 0 ${drag.width}px` : undefined,
      }}
      aria-label={`${label} column, ${count} items`}
    >
      <div className="group/colhead sticky top-0 z-[2] flex items-center gap-2 bg-[var(--bg)] px-[11px] pb-2.5 pt-0.5 max-[700px]:static max-[700px]:px-0.5 max-[700px]:pb-0.5">
        <StateCircle keyOf={stateKeyOf(status)} size={20} />
        <span className="text-[calc(13px*var(--text-scale))] font-semibold text-[var(--text-secondary)]">{label}</span>
        <span className="text-[calc(12px*var(--text-scale))] tabular-nums text-[var(--text-quaternary)]">{count}</span>
        {onQuickAdd && (
          <button
            type="button"
            aria-label={`New todo in ${label}`}
            data-testid={`board-quick-add-${status}`}
            onClick={onQuickAdd}
            className="focus-ring ml-auto grid size-6 place-items-center rounded-lg text-[var(--text-quaternary)] opacity-0 transition-opacity hover:bg-[var(--fill-tertiary)] hover:text-[var(--text-secondary)] focus-visible:opacity-100 group-hover/colhead:opacity-100 max-[700px]:size-11 max-[700px]:opacity-100"
          >
            <Plus size={13} strokeWidth={2.2} aria-hidden />
          </button>
        )}
      </div>
      <div
        ref={(el) => {
          bodyRef.current = el
          registerColumn(status)(el)
        }}
        className="flex flex-col gap-2 max-[700px]:gap-0"
      >
        {children}
        {hasMore && (
          <button
            type="button"
            data-testid={`board-show-more-${status}`}
            onClick={loadMore}
            disabled={loadingMore}
            className="focus-ring min-h-9 rounded-[var(--radius-lg)] bg-[var(--fill-quaternary)] px-[13px] text-left text-[calc(12px*var(--text-scale))] font-medium text-[var(--text-tertiary)] transition-colors hover:bg-[var(--fill-tertiary)] hover:text-[var(--text-secondary)]"
          >
            {loadingMore ? "Loading…" : `Show ${Math.min(BOARD_PAGE_SIZE, remaining)} more`}
          </button>
        )}
      </div>
    </section>
  )
}

/** The landing slot — a card-height fill-quaternary blank (states specimen 4). */
export function DragSlot({ height }: { height: number }) {
  return <div data-testid="board-drag-slot" aria-hidden className="rounded-[var(--radius-lg)] bg-[var(--fill-quaternary)]" style={{ height }} />
}
