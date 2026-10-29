import { useCallback, useMemo, useRef, useSyncExternalStore, type MouseEvent, type ReactNode } from "react"
import { NavigationType, useNavigate } from "react-router-dom"
import { useFileLinkSession } from "@/components/chat/file-link-session-context"
import { useOpenTodo } from "@/components/chat/file-open-context"
import { todoPath } from "@/lib/todo-id"
import { BoardLocationContext, type BoardLocation } from "./board-location"
import { boardKey, parseBoardParam, type BoardId } from "./board-route"

/* The Todos tab's own location. The board in a chat layout pane has no URL to keep its board and
 * filters in (the route is the chat's), so they live here: one record in localStorage, read through
 * a tiny module store so a seed written while the tab is on screen reaches it, and a reload or a
 * tab opened later starts where the last one left off. Every storage access is guarded: a browser
 * without storage keeps the location for the page's life instead. */

export const TODOS_TAB_LOCATION_KEY = "jinn-todos-tab-location"
const VERSION = 1

interface StoredLocation {
  board: BoardId
  search: string
}

const DEFAULT_LOCATION: StoredLocation = { board: { kind: "everything" }, search: "" }

/** The record while storage will not take it; null once it has. */
let memoryRaw: string | null = null
let cached: { raw: string | null; value: StoredLocation } = { raw: null, value: DEFAULT_LOCATION }
const listeners = new Set<() => void>()

function readRaw(): string | null {
  try {
    return memoryRaw ?? localStorage.getItem(TODOS_TAB_LOCATION_KEY)
  } catch {
    return memoryRaw
  }
}

function parse(raw: string | null): StoredLocation {
  if (!raw) return DEFAULT_LOCATION
  try {
    const stored = JSON.parse(raw) as { version?: unknown; board?: unknown; search?: unknown }
    if (stored.version !== VERSION) return DEFAULT_LOCATION
    return {
      board: parseBoardParam(typeof stored.board === "string" ? stored.board : undefined),
      search: typeof stored.search === "string" ? stored.search : "",
    }
  } catch {
    return DEFAULT_LOCATION
  }
}

/** The stored location; the same object until the stored text changes, as a store snapshot must be. */
function getSnapshot(): StoredLocation {
  const raw = readRaw()
  if (raw !== cached.raw) cached = { raw, value: parse(raw) }
  return cached.value
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  // Another window writing the same record moves this one too.
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === TODOS_TAB_LOCATION_KEY) listener()
  }
  window.addEventListener("storage", onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener("storage", onStorage)
  }
}

function commit(board: BoardId, search: string): void {
  const current = getSnapshot()
  if (boardKey(current.board) === boardKey(board) && current.search === search) return
  const raw = JSON.stringify({ version: VERSION, board: boardKey(board), search })
  try {
    localStorage.setItem(TODOS_TAB_LOCATION_KEY, raw)
    memoryRaw = null
  } catch {
    memoryRaw = raw
  }
  listeners.forEach((listener) => listener())
}

/** The tab's location now, and a subscription to its moves, for what describes the screen from outside it. */
export function readTodosTabLocation(): { board: BoardId; search: string } {
  return getSnapshot()
}
export { subscribe as subscribeTodosTabLocation }

/** Test-only: forget a location held in memory because storage refused it. */
export function clearTodosTabLocationMemory(): void {
  memoryRaw = null
}

/** Where the Todos tab opens next, for the page to call when a board link is taken into the tab:
 *  the board, and the query string its filters ride. A tab already on screen follows it. */
export function seedTodosTabLocation(board: BoardId, search: string): void {
  commit(board, search.replace(/^\?/, ""))
}

/** Opening a card: a Todo tab where the layout can take one, else the Todo's page, as at the route.
 *  A click the layout takes goes no further (`onClick`, on the tab's column), or the pane the board
 *  sits in would take focus back from the new tab, as todo-mention does. */
function useTodoHandOff() {
  const navigate = useNavigate()
  const openTab = useOpenTodo()
  const sessionId = useFileLinkSession()
  const handedOff = useRef(false)
  const openTodo = useCallback(
    (id: string, state?: Record<string, unknown>) => {
      if (openTab?.(id, sessionId)) {
        handedOff.current = true
        // A keyboard open has no click to guard; the flag must not outlive this turn.
        window.setTimeout(() => { handedOff.current = false }, 0)
        return
      }
      void navigate(todoPath(id), { state })
    },
    [openTab, sessionId, navigate],
  )
  const onClick = useCallback((event: MouseEvent) => {
    if (!handedOff.current) return
    handedOff.current = false
    event.stopPropagation()
  }, [])
  return { openTodo, onClick }
}

/** The Todos tab's board location, in the tab's column. */
export function TodosTabLocationProvider({ children }: { children: ReactNode }) {
  const stored = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const { openTodo, onClick } = useTodoHandOff()
  const searchParams = useMemo(() => new URLSearchParams(stored.search), [stored.search])
  // Back on the board the tab opened on is a return, which has the scroll put back; a board
  // reached from there is a fresh one, which starts at the top.
  const openedOn = useRef(boardKey(stored.board)).current
  const navigationType = boardKey(stored.board) === openedOn ? NavigationType.Pop : NavigationType.Push

  const setBoard = useCallback((board: BoardId) => commit(board, ""), [])
  const setSearchParams = useCallback(
    (next: URLSearchParams) => commit(getSnapshot().board, next.toString()),
    [],
  )
  const value = useMemo<BoardLocation>(
    () => ({ board: stored.board, setBoard, searchParams, setSearchParams, navigationType, openTodo }),
    [stored.board, setBoard, searchParams, setSearchParams, navigationType, openTodo],
  )
  return (
    <BoardLocationContext.Provider value={value}>
      {/* The header's actions drop under the title once a narrow pane cannot hold both. */}
      <div
        data-testid="todos-tab-view"
        onClick={onClick}
        className="relative flex h-full min-h-0 flex-1 flex-col [&_[data-slot=large-title-header]]:flex-wrap [&_[data-slot=large-title-header]>div]:min-w-40"
      >
        {children}
      </div>
    </BoardLocationContext.Provider>
  )
}
