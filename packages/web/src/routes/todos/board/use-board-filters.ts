import { useCallback, useEffect, useMemo } from "react"
import {
  filtersFromSearchParams,
  filtersToSearchParams,
  hasFilterParams,
  readPersistedFilters,
  writePersistedFilters,
  type TodoFilters,
} from "@/lib/todos"

const DEFAULT_FILTERS: TodoFilters = { status: "open" }

/**
 * The board's filter set, reconciled between the URL and localStorage.
 *
 * The URL is the authoritative, shareable copy: a URL that names any filter
 * wins, and is mirrored back to storage so the next empty URL can restore it.
 * An empty URL (a board switch, a new tab, a bare bookmark) falls back to the
 * stored set, and the URL is rewritten once to match — so the restored view is
 * reload-stable and still shareable.
 *
 * `setFilters` writes storage before touching the URL, so a clear writes the
 * cleared set and the storage fallback on the next render cannot resurrect the
 * filter the operator just removed.
 *
 * `enabled` is false for a board that has no filters of its own (Attention),
 * which reads and writes the URL exactly as before.
 */
export function useBoardFilters(
  searchParams: URLSearchParams,
  setSearchParams: (next: URLSearchParams, opts?: { replace?: boolean }) => void,
  enabled = true,
): { filters: TodoFilters; setFilters: (next: TodoFilters) => void } {
  const fromUrl = hasFilterParams(searchParams)
  const urlFilters = useMemo(() => filtersFromSearchParams(searchParams), [searchParams])
  // Only consult storage when the URL carries no filter of its own; the read is
  // memoised per URL commit so a state-only re-render cannot churn `filters`.
  const stored = useMemo(
    () => (enabled && !fromUrl ? readPersistedFilters() : null),
    [enabled, fromUrl, searchParams],
  )
  const filters = !enabled || fromUrl ? urlFilters : stored ?? DEFAULT_FILTERS

  // A URL-driven arrival (a shared link, back/forward) is worth remembering too.
  useEffect(() => {
    if (enabled && fromUrl) writePersistedFilters(filters)
  }, [enabled, fromUrl, filters])

  // An empty URL with a stored set: mirror it into the address bar once, so the
  // restored view is reload-stable and copy-pasteable.
  useEffect(() => {
    if (enabled && !fromUrl && stored) setSearchParams(filtersToSearchParams(stored), { replace: true })
  }, [enabled, fromUrl, stored, setSearchParams])

  const setFilters = useCallback(
    (next: TodoFilters) => {
      if (enabled) writePersistedFilters(next)
      setSearchParams(filtersToSearchParams(next), { replace: false })
    },
    [enabled, setSearchParams],
  )

  return { filters, setFilters }
}
