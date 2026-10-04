import { act, renderHook } from "@testing-library/react"
import { MemoryRouter, useSearchParams } from "react-router-dom"
import { beforeEach, describe, expect, it } from "vitest"
import { BOARD_FILTERS_STORAGE_KEY } from "@/lib/todos"
import { useBoardFilters } from "../board/use-board-filters"

/* The board's filter set must survive a return, a board switch and a new tab.
 * The URL still wins when it carries a filter; when it does not, the stored
 * set is the fallback — and a clear must stick rather than being undone by that
 * same fallback. This drives the real `useSearchParams` so the round trip is
 * the router's, not a stub of it. */

function renderFilters(initialEntry: string, enabled = true) {
  return renderHook(
    () => {
      const [params, setParams] = useSearchParams()
      return { ...useBoardFilters(params, setParams, enabled), search: params.toString() }
    },
    {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <MemoryRouter initialEntries={[initialEntry]}>{children}</MemoryRouter>
      ),
    },
  )
}

beforeEach(() => {
  localStorage.clear()
})

describe("useBoardFilters — URL and storage reconcile", () => {
  it("starts at the default on a genuinely empty board, storing nothing", () => {
    const { result } = renderFilters("/todos/b/home")
    expect(result.current.filters).toEqual({ status: "open" })
    expect(result.current.search).toBe("")
    expect(localStorage.getItem(BOARD_FILTERS_STORAGE_KEY)).toBeNull()
  })

  it("a URL that names a filter wins, and is remembered for next time", () => {
    const { result } = renderFilters("/todos/b/home?sprint=active&assignee=scout")
    expect(result.current.filters).toEqual({ status: "open", sprint: "active", assignee: "scout" })
    expect(localStorage.getItem(BOARD_FILTERS_STORAGE_KEY)).toBe("assignee=scout&sprint=active")
  })

  it("an empty URL falls back to the stored set and mirrors it back into the URL", () => {
    localStorage.setItem(BOARD_FILTERS_STORAGE_KEY, "sprint=active")
    const { result } = renderFilters("/todos/b/home")
    // A fresh mount (a new tab / a board switch that dropped the query) restores
    // the operator's view rather than resetting it.
    expect(result.current.filters).toEqual({ status: "open", sprint: "active" })
    expect(result.current.search).toBe("sprint=active")
  })

  it("a set writes both the URL and storage, and a clear sticks", () => {
    const { result } = renderFilters("/todos/b/home")
    act(() => result.current.setFilters({ status: "open", sprint: "active" }))
    expect(result.current.search).toBe("sprint=active")
    expect(localStorage.getItem(BOARD_FILTERS_STORAGE_KEY)).toBe("sprint=active")

    // Clearing writes the cleared set first, so the fallback cannot resurrect it.
    act(() => result.current.setFilters({ status: "open" }))
    expect(result.current.filters).toEqual({ status: "open" })
    expect(result.current.search).toBe("")
    expect(localStorage.getItem(BOARD_FILTERS_STORAGE_KEY)).toBeNull()
  })

  it("carries the whole set, sprint included, through the round trip", () => {
    const stored = "status=executing&assignee=scout&department=platform&source=cron&date=week&label=infra&sprint=active&due=overdue"
    localStorage.setItem(BOARD_FILTERS_STORAGE_KEY, stored)
    const { result } = renderFilters("/todos/b/everything")
    expect(result.current.filters).toEqual({
      status: "executing",
      assignee: "scout",
      department: "platform",
      source: "cron",
      date: "week",
      label: "infra",
      sprint: "active",
      due: "overdue",
    })
  })

  it("leaves a board without filters of its own alone (Attention)", () => {
    localStorage.setItem(BOARD_FILTERS_STORAGE_KEY, "sprint=active")
    const { result } = renderFilters("/todos/b/attention", false)
    // No fallback and no URL rewrite: the URL stays as it was.
    expect(result.current.filters).toEqual({ status: "open" })
    expect(result.current.search).toBe("")
    // And it does not overwrite the stored set either.
    expect(localStorage.getItem(BOARD_FILTERS_STORAGE_KEY)).toBe("sprint=active")
  })
})
