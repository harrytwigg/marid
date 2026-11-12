import { useCallback, useMemo, useState, type ReactNode } from "react"
import { NavigationType } from "react-router-dom"
import { BoardLocationContext, type BoardLocation } from "./board-location"
import type { BoardId, SubBoardDepth } from "./board-route"
import { useTodoHandOff } from "./todos-tab-location"

/** The board location of a sub-board in a pop-up: the Todo whose sub-Todos it shows, which level it reads, and its
 *  filters, all held in React state for as long as the pop-up is open. Nothing is written to the address bar or to
 *  storage, so the pop-up can neither move the page it opened over nor touch the main board's remembered filters.
 *
 *  `setBoard` moves only the depth: a sub-board has one root and no switcher. A card opens its Todo the way the board
 *  in a layout tab does (a Todo tab where the layout takes one, else the Todo's page), and the pop-up closes
 *  first, so the page it lands on is not under it. A stored variant for the pinned tab is the next consumer of this
 *  seam: it supplies the same `BoardLocation` from the tab's own record. */
export function SubBoardLocationProvider({
  rootId,
  initialDepth = "children",
  onClose,
  children,
}: {
  rootId: string
  initialDepth?: SubBoardDepth
  onClose: () => void
  children: ReactNode
}) {
  const [depth, setDepth] = useState<SubBoardDepth>(initialDepth)
  const [search, setSearch] = useState("")
  const { openTodo: handOff, onClick } = useTodoHandOff()

  const board = useMemo<BoardId>(() => ({ kind: "subtree", rootId, depth }), [rootId, depth])
  const searchParams = useMemo(() => new URLSearchParams(search), [search])
  const setBoard = useCallback(
    (next: BoardId) => {
      if (next.kind === "subtree" && next.rootId === rootId) setDepth(next.depth)
    },
    [rootId],
  )
  const setSearchParams = useCallback((next: URLSearchParams) => setSearch(next.toString()), [])
  const openTodo = useCallback(
    (id: string, state?: Record<string, unknown>) => {
      onClose()
      handOff(id, state)
    },
    [onClose, handOff],
  )
  const value = useMemo<BoardLocation>(
    // A fresh pop-up always starts at the top, so a return is never restored.
    () => ({ board, setBoard, searchParams, setSearchParams, navigationType: NavigationType.Push, openTodo }),
    [board, setBoard, searchParams, setSearchParams, openTodo],
  )
  return (
    <BoardLocationContext.Provider value={value}>
      <div onClick={onClick} className="flex h-full min-h-0 flex-1 flex-col">
        {children}
      </div>
    </BoardLocationContext.Provider>
  )
}
