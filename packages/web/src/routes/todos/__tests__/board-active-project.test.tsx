import { act, renderHook } from "@testing-library/react"
import { MemoryRouter, useSearchParams } from "react-router-dom"
import { beforeEach, describe, expect, it } from "vitest"
import { getActiveProject, resetActiveProjectForTests, setActiveProject } from "@/hooks/use-active-project"
import { BOARD_FILTERS_STORAGE_KEY } from "@/lib/todos"
import { useBoardFilters } from "../board/use-board-filters"

/* The board's project filter and the active project are one value: the active
 * project is the default when the URL names none, and a change on either side
 * reaches the other. */

const GARDEN = "prj_garden000001"
const BOAT = "prj_boat00000001"

function renderFilters(entry: string, enabled = true) {
  return renderHook(
    () => {
      const [params, setParams] = useSearchParams()
      return { ...useBoardFilters(params, setParams, enabled), search: params.toString() }
    },
    { wrapper: ({ children }: { children: React.ReactNode }) => <MemoryRouter initialEntries={[entry]}>{children}</MemoryRouter> },
  )
}

beforeEach(() => {
  localStorage.clear()
  resetActiveProjectForTests()
})

describe("useBoardFilters and the active project", () => {
  it("defaults the project filter to the active project when the URL names none", () => {
    setActiveProject(GARDEN)
    const { result } = renderFilters("/todos/b/everything")
    expect(result.current.filters.project).toBe(GARDEN)
  })

  it("keeps the project when the URL names other filters but no project", () => {
    setActiveProject(GARDEN)
    const { result } = renderFilters("/todos/b/everything?status=blocked")
    expect(result.current.filters).toMatchObject({ status: "blocked", project: GARDEN })
  })

  it("lets a project in the URL win and adopts it as the active project", () => {
    setActiveProject(GARDEN)
    const { result } = renderFilters(`/todos/b/everything?project=${BOAT}`)
    expect(result.current.filters.project).toBe(BOAT)
    expect(getActiveProject()).toBe(BOAT)
  })

  it("follows the switcher, rewriting a URL that named the old project", () => {
    const { result } = renderFilters(`/todos/b/everything?project=${GARDEN}`)
    act(() => setActiveProject(BOAT))
    expect(result.current.filters.project).toBe(BOAT)
    expect(result.current.search).toBe(`project=${BOAT}`)
    act(() => setActiveProject(undefined))
    expect(result.current.filters.project).toBeUndefined()
    expect(result.current.search).toBe("")
  })

  it("a project chosen on the chip becomes the active project, and clearing it clears it", () => {
    const { result } = renderFilters("/todos/b/everything")
    act(() => result.current.setFilters({ status: "open", project: BOAT }))
    expect(getActiveProject()).toBe(BOAT)
    expect(result.current.filters.project).toBe(BOAT)
    act(() => result.current.setFilters({ status: "open" }))
    expect(getActiveProject()).toBeUndefined()
    expect(result.current.filters.project).toBeUndefined()
    expect(result.current.search).toBe("")
  })

  it("does not restore a stored project over the active one", () => {
    localStorage.setItem(BOARD_FILTERS_STORAGE_KEY, `sprint=active&project=${BOAT}`)
    const { result } = renderFilters("/todos/b/everything")
    expect(result.current.filters).toEqual({ status: "open", sprint: "active" })
    expect(getActiveProject()).toBeUndefined()
  })

  it("leaves a board without filters of its own alone (Attention)", () => {
    setActiveProject(GARDEN)
    const { result } = renderFilters("/todos/b/attention", false)
    expect(result.current.filters).toEqual({ status: "open" })
  })
})
