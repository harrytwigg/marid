import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { TodoBoard } from "./board-page"
import { SubBoardLocationProvider } from "./sub-board-location"
import { usePinSubBoard } from "./use-pin-sub-board"

/** A Todo's sub-Todos as a board, over whatever page opened it. Large on a desktop; a phone gets the whole screen,
 *  where the board's own phone columns and "Move to…" menu apply unchanged. Lazily loaded (sub-board-dialog-lazy.tsx),
 *  so the Todo page does not carry the board. Escape, a press outside and the corner button close it.
 *  `closeOnOpenTodo` is false where the page closes it by the move itself (sub-board-location.tsx). */
export default function SubBoardDialog({ rootId, onClose, closeOnOpenTodo }: { rootId: string; onClose: () => void; closeOnOpenTodo?: boolean }) {
  const onPin = usePinSubBoard(rootId, onClose)
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent
        data-testid="sub-board-dialog"
        className="flex h-[min(88dvh,920px)] w-[min(1280px,calc(100vw-32px))] max-w-none sm:max-w-none flex-col gap-0 overflow-hidden p-0 pt-4 max-[700px]:fixed max-[700px]:inset-0 max-[700px]:top-0 max-[700px]:left-0 max-[700px]:h-dvh max-[700px]:w-screen max-[700px]:translate-x-0 max-[700px]:translate-y-0 max-[700px]:rounded-none"
      >
        <DialogTitle className="sr-only">Sub-Todos of {rootId} as a board</DialogTitle>
        <SubBoardLocationProvider rootId={rootId} onClose={onClose} closeOnOpenTodo={closeOnOpenTodo} onPin={onPin}>
          <TodoBoard embedded />
        </SubBoardLocationProvider>
      </DialogContent>
    </Dialog>
  )
}
