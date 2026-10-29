import { Navigate, redirect, useLocation, type LoaderFunctionArgs } from "react-router-dom"
import { TODOS_TAB_HREF } from "@/lib/todos-tab-entry"
import { boardPath, parseBoardParam, type BoardId } from "./board-route"

/** The board a legacy /todos URL means, and the query string its filters ride on.
 *  Old deep links keep meaning what they meant: the needs-you lens maps to the
 *  Attention board; the people lens (retired with the legacy list at the
 *  stage-C cutover, superseded by department boards) lands on Everything —
 *  the whole-org view is its closest surviving meaning. Remaining search
 *  params ride along so filtered bookmarks stay filtered. Pure — unit-tested
 *  directly. */
export function legacyTodosBoard(search: string): { board: BoardId; search: string } {
  const params = new URLSearchParams(search)
  const view = params.get("view")
  params.delete("view")
  const board = view === "needs" ? "attention" : "everything"
  return { board: parseBoardParam(board), search: params.toString() }
}

/** Where a legacy /todos URL lands now: the board path it maps to, as a link a person can read. */
export function legacyTodosRedirectTarget(search: string): string {
  const { board, search: rest } = legacyTodosBoard(search)
  return `${boardPath(board)}${rest ? `?${rest}` : ""}`
}

/** Takes a board link into the Todos tab: the tab is pointed at the board and its filters, then the chat
 *  route is asked to open it. The tab's location store is loaded here, not at start-up, with the rest of
 *  the tab. `seed` null leaves the tab where it was. */
async function intoTodosTab(seed: { board: BoardId; search: string } | null) {
  if (seed) {
    const { seedTodosTabLocation } = await import("./todos-tab-location")
    seedTodosTabLocation(seed.board, seed.search)
  }
  return redirect(TODOS_TAB_HREF)
}

/** Router-level redirect for /todos (and legacy /kanban): resolved during the
 *  navigation, BEFORE anything commits. An element-level <Navigate> renders
 *  null for a full commit, which unmounts the old page into an EMPTY root for
 *  a painted frame — on mobile the tab bar and page visibly flashed out on
 *  every chat → todos tap (and a view transition animates to that empty frame,
 *  stretching the flash to its full duration). A loader redirect produces one
 *  commit: old page → the chat route with the Todos tab open. */
export function todosIndexLoader({ request }: LoaderFunctionArgs) {
  const query = new URL(request.url).search
  // A bare address names no board and no filter, so it must not undo the board the tab was last left on.
  return intoTodosTab(query.replace(/^\?/, "") ? legacyTodosBoard(query) : null)
}

/** Router-level redirect for /todos/b/:board: the board is the Todos tab now, so a link to one (a bookmark,
 *  a department's board address) opens the tab on that board with the link's filters. A bare /todos or /kanban opens the tab where it was left. */
export function todosBoardLoader({ params, request }: LoaderFunctionArgs) {
  return intoTodosTab({ board: parseBoardParam(params.board), search: new URL(request.url).search })
}

/** Route element for the /todos index: redirect into the Todos tab.
 *  Unreachable while todosIndexLoader is wired (the loader always redirects);
 *  kept as the belt-and-braces fallback. */
export function TodosIndexRedirect() {
  const location = useLocation()
  return <Navigate to={legacyTodosRedirectTarget(location.search)} replace />
}

/** Route element for /todos/b/:board, as unreachable as the index's while todosBoardLoader is wired. */
export function TodosBoardRedirect() {
  return <Navigate to={TODOS_TAB_HREF} replace />
}
