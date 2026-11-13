import { lazy, Suspense } from "react"
import { LoadBoundary, LoadingScrim } from "@/components/ui/lazy-overlay"

/* The sub-board pop-up carries the whole board, so it is a chunk of its own that loads when the "View as board" button is
 * hovered, focused or touched, and on a press if it has not: an inert scrim stands in until it lands, and a chunk that
 * cannot be fetched is reported on the notice surface and the pop-up closes. */

const load = () => import("./sub-board-dialog")
const SubBoardDialog = lazy(load)

/** Starts the fetch; a failed one is reported to whoever opens the pop-up, not here. */
export function preloadSubBoardDialog(): void {
  void load().catch(() => {})
}

/** Props that start the fetch from the button that opens the pop-up. */
export const SUB_BOARD_PRELOAD = {
  onPointerEnter: preloadSubBoardDialog,
  onFocus: preloadSubBoardDialog,
  onTouchStart: preloadSubBoardDialog,
} as const

export function LazySubBoardDialog({ rootId, onClose, closeOnOpenTodo }: { rootId: string; onClose: () => void; closeOnOpenTodo?: boolean }) {
  return (
    <LoadBoundary what="The sub-board" onFailed={onClose}>
      <Suspense fallback={<LoadingScrim testId="sub-board-loading" />}>
        <SubBoardDialog rootId={rootId} onClose={onClose} closeOnOpenTodo={closeOnOpenTodo} />
      </Suspense>
    </LoadBoundary>
  )
}
