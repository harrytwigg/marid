/**
 * What is on the page, taken from the cache the page itself filled.
 *
 * Reads only — `getQueryData`, never `fetchQuery`. A snapshot is published on
 * every navigation, and a fetch here would turn moving around the app into
 * traffic the operator did not ask for. A cold cache answers with nothing, which
 * renders as a view with no object list rather than as a wrong one.
 */
import { queryClient } from "@/lib/query-client"
import { queryKeys } from "@/lib/query-keys"
import { filtersFromSearchParams } from "@/lib/todos"
import { parseBoardParam } from "@/routes/todos/board/board-route"
import { BOARD_STATUS_ORDER, isColumnInStatusFilter } from "@/routes/todos/board/status-scope"
import { boardColumnQueryKey } from "@/routes/todos/board/use-board"
import type { PageSnapshot } from "./page-snapshot"

export interface VisibleObject {
  id: string
  title: string
}

/** Pull `{ id, title }` off a cached list whose rows are only loosely typed —
 *  sessions and cron jobs come back as `Record<string, unknown>[]`. A row with
 *  no usable id is skipped: an object the orb cannot name is one it cannot act
 *  on either. */
function rowsOf(value: unknown, idField: string, titleField: string): VisibleObject[] {
  if (!Array.isArray(value)) return []
  const objects: VisibleObject[] = []
  for (const row of value) {
    if (!row || typeof row !== "object") continue
    const fields = row as Record<string, unknown>
    const id = fields[idField]
    if (typeof id !== "string" || id.trim() === "") continue
    const title = fields[titleField]
    objects.push({ id: id.trim(), title: typeof title === "string" ? title : "" })
  }
  return objects
}

/** The list a cached response carries under `field`. Most of these endpoints
 *  answer with an envelope rather than a bare array. */
function cachedList(key: readonly unknown[], field: string): unknown {
  const held = queryClient.getQueryData(key)
  if (!held || typeof held !== "object") return undefined
  return (held as Record<string, unknown>)[field]
}

function pageItems(page: unknown): VisibleObject[] {
  return rowsOf((page as { workItems?: unknown } | undefined)?.workItems, "id", "title")
}

/**
 * The board is one infinite query per status column, each keyed by the board AND
 * the active filters, so there is no single entry holding "the board" — and the
 * entries a filter change left behind are still in the cache. Asking
 * `boardColumnQueryKey` for the exact key of each column this board is showing
 * is what keeps a search the operator has typed past off the screen; the same
 * Todo can sit in two live columns across a status change, so ids are deduped.
 */
function boardObjects(snapshot: PageSnapshot): VisibleObject[] {
  const key = snapshot.params.board
  if (!key) return []
  const board = parseBoardParam(key)
  // Back through the same parser the board itself reads the URL with, so the
  // key this builds is the key the page wrote.
  const filters = filtersFromSearchParams(new URLSearchParams(snapshot.filters))
  const seen = new Set<string>()
  const objects: VisibleObject[] = []
  for (const status of BOARD_STATUS_ORDER) {
    if (!isColumnInStatusFilter(filters.status, status)) continue
    const column = queryClient.getQueryData(boardColumnQueryKey(board, status, filters))
    const pages = (column as { pages?: unknown } | undefined)?.pages
    if (!Array.isArray(pages)) continue
    for (const item of pages.flatMap(pageItems)) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      objects.push(item)
    }
  }
  return objects
}

/** The objects the operator can see on the surface this snapshot describes. */
export function visibleObjects(snapshot: PageSnapshot): VisibleObject[] {
  switch (snapshot.kind) {
    case "todos":
      return boardObjects(snapshot)
    case "chat":
      return rowsOf(cachedList(queryKeys.sessions.all, "sessions"), "id", "title")
    case "org":
      return rowsOf(cachedList(queryKeys.org.all, "employees"), "name", "displayName")
    case "cron":
      return rowsOf(queryClient.getQueryData(queryKeys.cron.jobs), "id", "name")
    case "notes":
      return rowsOf(cachedList(queryKeys.notes.list(), "notes"), "path", "title")
    default:
      // Every other surface either shows one object, which the selection already
      // names, or keeps no list this module has been taught to read.
      return []
  }
}
