import { boardPath, type BoardId } from "@/routes/todos/board/board-route"
import { describeLocation } from "./page-snapshot"
import type { PageSnapshot } from "./screen-context-types"

/**
 * `describeLocation`, told where the Todos tab is. The tab is a pane of the chat route, which carries no
 * trace of it in the address: while it is the focused tab, the screen is the board at the tab's own board
 * and filters, and is described as the board's route would have been.
 */
export function describeScreenLocation(
  pathname: string,
  search: string,
  tab: { board: BoardId; search: string } | null,
): PageSnapshot {
  if (tab && pathname === "/") return describeLocation(boardPath(tab.board), tab.search ? `?${tab.search}` : "")
  return describeLocation(pathname, search)
}
