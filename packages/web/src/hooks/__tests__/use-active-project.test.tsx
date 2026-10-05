import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  ACTIVE_PROJECT_STORAGE_KEY,
  getActiveProject,
  resetActiveProjectForTests,
  setActiveProject,
  useActiveProject,
} from "../use-active-project"

beforeEach(() => {
  localStorage.clear()
  resetActiveProjectForTests()
})
afterEach(() => vi.restoreAllMocks())

describe("active project store", () => {
  it("starts empty and remembers a choice in storage", () => {
    expect(getActiveProject()).toBeUndefined()
    setActiveProject("prj_garden000001")
    expect(localStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY)).toBe("prj_garden000001")
    setActiveProject(undefined)
    expect(localStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY)).toBeNull()
  })

  it("reads a stored choice on first use", () => {
    localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, "prj_boat00000001")
    expect(getActiveProject()).toBe("prj_boat00000001")
  })

  it("re-renders subscribers when it changes", () => {
    const { result } = renderHook(() => useActiveProject())
    expect(result.current).toBeUndefined()
    act(() => setActiveProject("none"))
    expect(result.current).toBe("none")
  })

  it("follows a change made in another tab", () => {
    const { result } = renderHook(() => useActiveProject())
    act(() => {
      localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, "prj_boat00000001")
      window.dispatchEvent(new StorageEvent("storage", { key: ACTIVE_PROJECT_STORAGE_KEY }))
    })
    expect(result.current).toBe("prj_boat00000001")
  })

  it("stays usable in memory when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    expect(getActiveProject()).toBeUndefined()
    expect(() => setActiveProject("prj_garden000001")).not.toThrow()
    expect(getActiveProject()).toBe("prj_garden000001")
    expect(() => setActiveProject(undefined)).not.toThrow()
    expect(getActiveProject()).toBeUndefined()
  })
})
