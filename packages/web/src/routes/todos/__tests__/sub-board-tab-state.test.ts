import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { clearSubBoardTabState, readSubBoardTabState, useSubBoardTabState, writeSubBoardTabState } from "../board/sub-board-tab-state"

const KEY = "hundredfold-sub-board-tab:ACM-7"

describe("a sub-board tab's stored state", () => {
  beforeEach(() => {
    clearSubBoardTabState("ACM-7")
    clearSubBoardTabState("ACM-8")
    localStorage.clear()
  })
  afterEach(() => vi.restoreAllMocks())

  it("starts at the children with no filters", () => {
    expect(readSubBoardTabState("ACM-7")).toEqual({ depth: "children", search: "" })
  })

  it("keeps depth and filters per Todo, in the browser's storage", () => {
    writeSubBoardTabState("ACM-7", { depth: "all", search: "status=open&q=schema" })
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toMatchObject({ depth: "all", search: "status=open&q=schema" })
    expect(readSubBoardTabState("ACM-7")).toEqual({ depth: "all", search: "status=open&q=schema" })
    expect(readSubBoardTabState("ACM-8")).toEqual({ depth: "children", search: "" })
  })

  it("is the same object until something is written, as a store snapshot must be", () => {
    writeSubBoardTabState("ACM-7", { depth: "all", search: "" })
    const first = readSubBoardTabState("ACM-7")
    expect(readSubBoardTabState("ACM-7")).toBe(first)
  })

  it("reads a record written before the page loaded, and ignores one it cannot make sense of", () => {
    localStorage.setItem(KEY, JSON.stringify({ version: 1, depth: "all", search: "x=1" }))
    expect(readSubBoardTabState("ACM-7")).toEqual({ depth: "all", search: "x=1" })
    clearSubBoardTabState("ACM-7")
    localStorage.setItem(KEY, "{not json")
    expect(readSubBoardTabState("ACM-7")).toEqual({ depth: "children", search: "" })
    localStorage.setItem(KEY, JSON.stringify({ version: 99, depth: "all", search: "x=1" }))
    expect(readSubBoardTabState("ACM-7")).toEqual({ depth: "children", search: "" })
  })

  it("is removed when the tab closes", () => {
    writeSubBoardTabState("ACM-7", { depth: "all", search: "x=1" })
    clearSubBoardTabState("ACM-7")
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(readSubBoardTabState("ACM-7")).toEqual({ depth: "children", search: "" })
  })

  it("holds the state in memory for the page when storage refuses it, and still clears", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota") })
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked") })
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("blocked") })
    writeSubBoardTabState("ACM-7", { depth: "all", search: "x=1" })
    expect(readSubBoardTabState("ACM-7")).toEqual({ depth: "all", search: "x=1" })
    clearSubBoardTabState("ACM-7")
    expect(readSubBoardTabState("ACM-7")).toEqual({ depth: "children", search: "" })
  })

  it("moves a mounted tab when its state is written, one move keeping the other value", () => {
    const { result } = renderHook(() => useSubBoardTabState("ACM-7"))
    act(() => result.current.setSearch("status=done"))
    act(() => result.current.setDepth("all"))
    expect(result.current.state).toEqual({ depth: "all", search: "status=done" })
    act(() => result.current.setSearch(""))
    expect(result.current.state).toEqual({ depth: "all", search: "" })
  })
})
