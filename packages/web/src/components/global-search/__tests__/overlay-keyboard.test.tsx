import "@/test/preload-dialogs"
import { fireEvent, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ searchGlobal: vi.fn() }))

vi.mock("@/lib/search-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/search-api")>()
  return { ...actual, searchGlobal: mocks.searchGlobal }
})
vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings: { portalName: "Jinn" } }) }))

import { renderOverlay, searchField } from "./harness"
import { searchResponse, searchResult } from "./fixtures"

const RESULTS = [
  searchResult({ kind: "todo", id: "AAA-1", preview: { title: "First row", excerpt: "", url: "/todos/AAA-1" }, url: "/todos/AAA-1" }),
  searchResult({ kind: "todo", id: "AAA-2", preview: { title: "Second row", excerpt: "", url: "/todos/AAA-2" }, url: "/todos/AAA-2" }),
  searchResult({ kind: "note", id: "n-1", preview: { title: "Third row", excerpt: "", url: "/notes/n-1" }, url: "/notes/n-1" }),
]

async function typeQuery(text = "match") {
  fireEvent.change(searchField(), { target: { value: text } })
  await screen.findByTestId("search-row-todo:AAA-1")
}

describe("the overlay, driven from the keyboard alone", () => {
  beforeEach(() => {
    localStorage.clear()
    mocks.searchGlobal.mockReset()
    mocks.searchGlobal.mockResolvedValue(searchResponse({ results: RESULTS }))
  })

  it("moves the selection down and up, and the preview follows it", async () => {
    renderOverlay()
    await typeQuery()
    expect(screen.getByTestId("search-preview").textContent).toContain("First row")

    fireEvent.keyDown(searchField(), { key: "ArrowDown" })
    expect(screen.getByTestId("search-preview").textContent).toContain("Second row")

    fireEvent.keyDown(searchField(), { key: "ArrowDown" })
    expect(screen.getByTestId("search-preview").textContent).toContain("Third row")

    fireEvent.keyDown(searchField(), { key: "ArrowUp" })
    expect(screen.getByTestId("search-preview").textContent).toContain("Second row")
  })

  it("wraps at both ends so either end is one keypress away", async () => {
    renderOverlay()
    await typeQuery()

    fireEvent.keyDown(searchField(), { key: "ArrowUp" })
    expect(screen.getByTestId("search-preview").textContent).toContain("Third row")

    fireEvent.keyDown(searchField(), { key: "ArrowDown" })
    expect(screen.getByTestId("search-preview").textContent).toContain("First row")
  })

  it("opens the selected row on Enter and remembers it", async () => {
    renderOverlay()
    await typeQuery()

    fireEvent.keyDown(searchField(), { key: "ArrowDown" })
    fireEvent.keyDown(searchField(), { key: "Enter" })

    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/todos/AAA-2"))
    expect(JSON.parse(localStorage.getItem("jinn-command-recent") ?? "[]")).toEqual([
      { id: "todo-AAA-2", label: "AAA-2 row", href: "/todos/AAA-2", type: "todo" },
    ])
  })

  it("clears a non-empty query on the first Escape and closes on the second", async () => {
    renderOverlay()
    await typeQuery()

    fireEvent.keyDown(searchField(), { key: "Escape" })
    await waitFor(() => expect(searchField().value).toBe(""))

    fireEvent.keyDown(searchField(), { key: "Escape" })
    await waitFor(() => expect(document.querySelector("input[aria-label^='Search']")).toBeNull())
  })

  it("closes straight away when Escape lands on an empty query", async () => {
    renderOverlay()
    await screen.findByTestId("search-preview-hint")

    fireEvent.keyDown(searchField(), { key: "Escape" })

    await waitFor(() => expect(document.querySelector("input[aria-label^='Search']")).toBeNull())
  })
})
