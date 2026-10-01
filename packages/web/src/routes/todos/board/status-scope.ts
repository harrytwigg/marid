import type { WorkItemStatusWire } from "@/lib/api"
import type { StatusFilter } from "@/lib/todos"

/* What a status-filtered board IS — the status universe and the two questions
 * asked of it — kept pure so it can be unit-tested away from the queries.
 * Columns ARE the status dimension, so `?status=…` narrows which columns exist
 * rather than filtering within one. */

export const PIPELINE_STATUSES: readonly WorkItemStatusWire[] = ["backlog", "executing", "in_review"]
export const EXCEPTION_STATUSES: readonly WorkItemStatusWire[] = ["blocked"]
export const CLOSED_STATUSES: readonly WorkItemStatusWire[] = ["done", "cancelled"]
export const BOARD_STATUS_ORDER: readonly WorkItemStatusWire[] = [
  ...PIPELINE_STATUSES, ...EXCEPTION_STATUSES, ...CLOSED_STATUSES,
]

/** Whether a column belongs on a board carrying this status filter. A URL that
 *  names one status (`?status=executing`, which is what the Talk orb's
 *  open_todos writes) is a board of that one column; `open` and `all` keep every
 *  column, closed ones included, for the rail to page. */
export function isColumnInStatusFilter(filter: StatusFilter, status: WorkItemStatusWire): boolean {
  return filter === "open" || filter === "all" || filter === status
}

/** How many cards such a board actually shows. Closed columns count too:
 *  `?status=done` has exactly one non-empty column and it is a closed one, so
 *  tallying only the open statuses reads that board as empty and hides the Todo
 *  behind "No todos match." */
export function visibleItemCount(
  filter: StatusFilter,
  itemsByStatus: Partial<Record<WorkItemStatusWire, readonly unknown[]>>,
): number {
  return BOARD_STATUS_ORDER.reduce(
    (sum, status) => sum + (isColumnInStatusFilter(filter, status) ? itemsByStatus[status]?.length ?? 0 : 0),
    0,
  )
}
