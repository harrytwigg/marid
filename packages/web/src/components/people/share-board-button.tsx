import { lazy, Suspense, useState } from "react"
import { Users } from "@/components/ui/icon"
import { Button } from "@/components/ui/button"
import { LoadBoundary, LoadingScrim } from "@/components/ui/lazy-overlay"
import type { BoardShareDialogProps } from "./board-share-dialog"

/* Share is pressed rarely, so the dialog (its roster queries, forms and the modal it is drawn in) is its own chunk: it loads
 * when the button is hovered, focused or touched, and a press before that shows the inert scrim until it lands. If the chunk
 * cannot be fetched the notice surface says so and the dialog closes. */

const load = () => import("./board-share-dialog")
const BoardShareDialog = lazy(() => load().then((module) => ({ default: module.BoardShareDialog })))

function preload(): void {
  void load().catch(() => {})
}

export type ShareBoardButtonProps = Omit<BoardShareDialogProps, "open" | "onClose"> & { className?: string }

/** The Share control for one department board: the operator renders it on the board's header, a board owner in the member shell. */
export function ShareBoardButton({ className, ...dialog }: ShareBoardButtonProps) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        variant="secondary"
        size="icon"
        data-testid="board-share"
        aria-label="Share board"
        title="Share this board"
        onClick={() => setOpen(true)}
        onPointerEnter={preload}
        onFocus={preload}
        onTouchStart={preload}
        className={className ?? "size-10 rounded-full"}
      >
        <Users className="size-4" aria-hidden />
      </Button>
      {open && (
        <LoadBoundary what="The share dialog" onFailed={() => setOpen(false)}>
          <Suspense fallback={<LoadingScrim testId="board-share-loading" />}>
            <BoardShareDialog {...dialog} open onClose={() => setOpen(false)} />
          </Suspense>
        </LoadBoundary>
      )}
    </>
  )
}
