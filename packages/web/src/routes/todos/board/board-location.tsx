import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react"
import { useNavigate, useNavigationType, useParams, useSearchParams, type NavigationType } from "react-router-dom"
import { todoPath } from "@/lib/todo-id"
import { boardPath, parseBoardParam, type BoardId } from "./board-route"

/** Where the board is, and how it moves: the one seam between the board and whatever holds its
 *  location. At its route that is the URL; as a chat layout tab it is the tab's own stored state
 *  (todos-tab-location.tsx), so a board in a pane never writes the address bar. */
export interface BoardLocation {
  board: BoardId
  setBoard: (board: BoardId) => void
  searchParams: URLSearchParams
  setSearchParams: (next: URLSearchParams, opts?: { replace?: boolean }) => void
  /** How the board was reached, for putting the reader's scroll position back (use-board-scroll). */
  navigationType: NavigationType
  /** Opens a Todo from a card: the Todo's page, or a Todo tab where the layout can take one. */
  openTodo: (id: string, state?: Record<string, unknown>) => void
}

export const BoardLocationContext = createContext<BoardLocation | null>(null)

export function useBoardLocation(): BoardLocation {
  const location = useContext(BoardLocationContext)
  if (!location) throw new Error("useBoardLocation needs a BoardLocationContext provider")
  return location
}

/** What the switcher calls to change board: the surrounding location's own move, and, with no
 *  board around it, the board's route. */
export function useSwitchBoard(): (board: BoardId) => void {
  const location = useContext(BoardLocationContext)
  const navigate = useNavigate()
  return useCallback(
    (board) => (location ? location.setBoard(board) : navigate(boardPath(board))),
    [location, navigate],
  )
}

/** The board as its route has always had it: the board is `:board`, the filters are the query
 *  string, and a card is a navigation to the Todo's page. */
export function RouteBoardLocationProvider({ children }: { children: ReactNode }) {
  const { board: boardParam } = useParams()
  const navigationType = useNavigationType()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const board = useMemo(() => parseBoardParam(boardParam), [boardParam])
  const setBoard = useCallback((next: BoardId) => navigate(boardPath(next)), [navigate])
  const openTodo = useCallback(
    (id: string, state?: Record<string, unknown>) => navigate(todoPath(id), { state }),
    [navigate],
  )
  const value = useMemo<BoardLocation>(
    () => ({ board, setBoard, searchParams, setSearchParams, navigationType, openTodo }),
    [board, setBoard, searchParams, setSearchParams, navigationType, openTodo],
  )
  return <BoardLocationContext.Provider value={value}>{children}</BoardLocationContext.Provider>
}
