import { useMemo } from "react"
import { TodoBoard } from "./board-page"
import { SubBoardLocationProvider, type SubBoardStore } from "./sub-board-location"
import { useSubBoardRoot } from "./sub-board-root"
import { useSubBoardTabState } from "./sub-board-tab-state"

const NO_OP = () => {}

/** A tab whose Todo is gone, or not one this person can see: calm, and the tab stays closable and unpinnable from its strip. */
function Unavailable() {
  return (
    <div role="status" data-testid="sub-board-tab-unavailable" className="flex flex-1 flex-col items-center justify-center gap-1.5 p-8 text-center">
      <p className="text-[length:var(--text-subheadline)] font-medium text-[var(--text-secondary)]">This Todo&apos;s board isn&apos;t available</p>
      <p className="max-w-sm text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">
        It may have been removed, or you may not be able to see it. You can close or unpin this tab.
      </p>
    </div>
  )
}

function Body({ todoId }: { todoId: string }) {
  const { missing } = useSubBoardRoot({ kind: "subtree", rootId: todoId, depth: "children" })
  return missing ? <Unavailable /> : <TodoBoard embedded />
}

/** A Todo's sub-board as a chat layout tab: the board over the sub-board location (sub-board-location.tsx) with its depth
 *  and filters kept in the tab's own stored record, so a reload brings it back where it was. Lazily loaded by DocView, so the
 *  chat pays for none of it until the tab opens. */
export default function SubBoardTabView({ todoId }: { todoId: string }) {
  const { state, setDepth, setSearch } = useSubBoardTabState(todoId)
  const store = useMemo<SubBoardStore>(() => ({ ...state, setDepth, setSearch }), [state, setDepth, setSearch])
  return (
    <div data-testid="sub-board-tab-view" className="relative flex h-full min-h-0 flex-1 flex-col">
      {/* A card opens its Todo as a tab where the layout takes one; there is no pop-up to close, and nothing to pin. */}
      <SubBoardLocationProvider rootId={todoId} onClose={NO_OP} closeOnOpenTodo={false} store={store}>
        <Body todoId={todoId} />
      </SubBoardLocationProvider>
    </div>
  )
}
