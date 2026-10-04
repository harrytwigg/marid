// The Todos board filter set, remembered across navigation and new tabs.
// The URL query string stays the source of truth while it names a filter
// (shareable, survives refresh); this is the fallback for a board opened with
// no filter params, so leaving and returning, switching boards and opening a
// new tab all land on the operator's last selection instead of the defaults.

import { filtersFromSearchParams, filtersToSearchParams, type TodoFilters } from "./todos"

export const BOARD_FILTERS_KEY = "jinn-board-filters"

/** Every query param that carries a board filter. */
const FILTER_PARAMS = ["status", "assignee", "department", "source", "date", "label", "sprint", "due", "q"] as const

/** True when the URL names at least one filter, even a default-valued one. */
export function hasFilterParams(params: URLSearchParams): boolean {
  return FILTER_PARAMS.some((name) => params.has(name))
}

/** The remembered filters as URL params; empty when nothing (valid) is stored. */
export function loadPersistedFilterParams(): URLSearchParams {
  try {
    const raw = localStorage.getItem(BOARD_FILTERS_KEY)
    if (!raw) return new URLSearchParams()
    return filtersToSearchParams(filtersFromSearchParams(new URLSearchParams(raw)))
  } catch {
    return new URLSearchParams()
  }
}

/** Remember the filter set; the default set clears the entry. */
export function savePersistedFilters(filters: TodoFilters): void {
  try {
    const query = filtersToSearchParams(filters).toString()
    if (query) localStorage.setItem(BOARD_FILTERS_KEY, query)
    else localStorage.removeItem(BOARD_FILTERS_KEY)
  } catch {
    /* a convenience, not state anyone depends on */
  }
}

/** The params the board should read: the URL's own when it names a filter,
 *  otherwise the remembered set layered over whatever else the URL carries. */
export function resolveBoardFilterParams(urlParams: URLSearchParams): URLSearchParams {
  if (hasFilterParams(urlParams)) return urlParams
  const persisted = loadPersistedFilterParams()
  if (persisted.toString() === "") return urlParams
  const merged = new URLSearchParams(urlParams)
  persisted.forEach((value, name) => merged.set(name, value))
  return merged
}
