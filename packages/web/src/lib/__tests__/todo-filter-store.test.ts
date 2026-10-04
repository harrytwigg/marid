import { beforeEach, describe, expect, it } from "vitest"
import {
  BOARD_FILTERS_KEY,
  hasFilterParams,
  loadPersistedFilterParams,
  resolveBoardFilterParams,
  savePersistedFilters,
} from "../todo-filter-store"

beforeEach(() => localStorage.clear())

describe("todo filter store", () => {
  it("round-trips a filter set through storage", () => {
    savePersistedFilters({ status: "all", sprint: "s-1", label: "infra", q: "deploy" })
    expect(Object.fromEntries(loadPersistedFilterParams())).toEqual({
      status: "all", sprint: "s-1", label: "infra", q: "deploy",
    })
  })

  it("removes the entry when the default set is saved", () => {
    savePersistedFilters({ status: "open", sprint: "s-1" })
    savePersistedFilters({ status: "open" })
    expect(localStorage.getItem(BOARD_FILTERS_KEY)).toBeNull()
  })

  it("drops invalid stored values and survives unparseable storage", () => {
    localStorage.setItem(BOARD_FILTERS_KEY, "status=bogus&due=never&sprint=s-2")
    expect(loadPersistedFilterParams().toString()).toBe("sprint=s-2")
  })

  it("detects filter params, ignoring unrelated ones", () => {
    expect(hasFilterParams(new URLSearchParams("sprint=s-1"))).toBe(true)
    expect(hasFilterParams(new URLSearchParams("status=open"))).toBe(true)
    expect(hasFilterParams(new URLSearchParams("view=x"))).toBe(false)
  })

  it("prefers URL params and falls back to the remembered set", () => {
    savePersistedFilters({ status: "open", sprint: "s-1" })
    const url = new URLSearchParams("label=ops")
    expect(resolveBoardFilterParams(url)).toBe(url)
    expect(resolveBoardFilterParams(new URLSearchParams("view=x")).toString()).toBe("view=x&sprint=s-1")
    expect(resolveBoardFilterParams(new URLSearchParams()).toString()).toBe("sprint=s-1")
  })
})
