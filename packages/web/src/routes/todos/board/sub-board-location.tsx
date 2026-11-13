import { useCallback, useMemo, useState, type ReactNode } from "react"
import { NavigationType } from "react-router-dom"
import { BoardLocationContext, type BoardLocation } from "./board-location"
import type { BoardId, SubBoardDepth } from "./board-route"
import { useTodoHandOff } from "./todos-tab-location"

/** Where a sub-board keeps its depth and filter search when the holder wants them kept somewhere other than React state:
 *  the pinned tab's stored record (sub-board-tab-state.ts). */
export interface SubBoardStore {
  depth: SubBoardDepth
  search: string
  setDepth: (depth: SubBoardDepth) => void
  setSearch: (search: string) => void
}

/** The depth and filter search: the holder's store when it supplies one, else React state of this provider's own. */
function useSubBoardState(initialDepth: SubBoardDepth, store: SubBoardStore | undefined): SubBoardStore {
  const [localDepth, setLocalDepth] = useState<SubBoardDepth>(initialDepth)
  const [localSearch, setLocalSearch] = useState("")
  return {
    depth: store?.depth ?? localDepth,
    search: store?.search ?? localSearch,
    setDepth: store?.setDepth ?? setLocalDepth,
    setSearch: store?.setSearch ?? setLocalSearch,
  }
}

/** The board location of a sub-board: the Todo whose sub-Todos it shows, which level it reads, and its filters. By
 *  default they are held in React state for as long as the holder (the pop-up) is mounted: nothing is written to the
 *  address bar or to storage, so a sub-board can neither move the page it opened over nor touch the main board's
 *  remembered filters. The pinned tab supplies a `store`, so the same two values live in its own stored record.
 *
 *  `setBoard` moves only the depth: a sub-board has one root and no switcher. A card opens its Todo the way the board
 *  in a layout tab does (a Todo tab where the layout takes one, else the Todo's page); the pop-up closes first
 *  (`onClose`), so the page it lands on is not under it, unless its holder closes it by the move itself
 *  (`closeOnOpenTodo` false: the routed page, whose pop-up is a query parameter the next page does not carry, and a
 *  tab, which has nothing to close). `onPin` is the holder's way of pinning this board as a tab, when it has one. */
export function SubBoardLocationProvider({
  rootId,
  initialDepth = "children",
  onClose,
  closeOnOpenTodo = true,
  onPin,
  store,
  children,
}: {
  rootId: string
  initialDepth?: SubBoardDepth
  onClose: () => void
  closeOnOpenTodo?: boolean
  onPin?: () => void
  store?: SubBoardStore
  children: ReactNode
}) {
  const { depth, search, setDepth, setSearch } = useSubBoardState(initialDepth, store)
  const { openTodo: handOff, onClick } = useTodoHandOff()

  const board = useMemo<BoardId>(() => ({ kind: "subtree", rootId, depth }), [rootId, depth])
  const searchParams = useMemo(() => new URLSearchParams(search), [search])
  const setBoard = useCallback(
    (next: BoardId) => {
      if (next.kind === "subtree" && next.rootId === rootId) setDepth(next.depth)
    },
    [rootId, setDepth],
  )
  const setSearchParams = useCallback((next: URLSearchParams) => setSearch(next.toString()), [setSearch])
  const openTodo = useCallback(
    (id: string, state?: Record<string, unknown>) => {
      if (closeOnOpenTodo) onClose()
      handOff(id, state)
    },
    [closeOnOpenTodo, onClose, handOff],
  )
  const value = useMemo<BoardLocation>(
    // A fresh sub-board always starts at the top, so a return is never restored.
    () => ({ board, setBoard, searchParams, setSearchParams, navigationType: NavigationType.Push, openTodo, pinAsTab: onPin }),
    [board, setBoard, searchParams, setSearchParams, openTodo, onPin],
  )
  return (
    <BoardLocationContext.Provider value={value}>
      <div onClick={onClick} className="flex h-full min-h-0 flex-1 flex-col">
        {children}
      </div>
    </BoardLocationContext.Provider>
  )
}
