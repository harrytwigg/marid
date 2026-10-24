import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { ResultList } from "../result-list"
import { statusTint } from "../kind-meta"
import { recentRows, resultRows } from "../rows"
import { searchResult } from "./fixtures"

/** One flat payload in `SEARCH_KINDS` order, with a kind run longer than one. */
const RESULTS = [
  searchResult({ kind: "todo", id: "AAA-1" }),
  searchResult({ kind: "todo", id: "AAA-2" }),
  searchResult({ kind: "session", id: "s-1" }),
  searchResult({ kind: "note", id: "n-1" }),
  searchResult({ kind: "note", id: "n-2" }),
  searchResult({ kind: "page", id: "p-1" }),
]

function renderList(rows = resultRows(RESULTS), selectedIndex = 0) {
  const onSelect = vi.fn()
  const onActivate = vi.fn()
  const view = render(
    <ResultList rows={rows} selectedIndex={selectedIndex} onSelect={onSelect} onActivate={onActivate} emptyLabel="No results" loading={false} />,
  )
  return { ...view, onSelect, onActivate }
}

describe("ResultList", () => {
  it("renders one ranked list grouped into contiguous kind runs, one head per run", () => {
    const { container } = renderList()

    const heads = [...container.querySelectorAll("[role='presentation']")].map(node => node.textContent)
    expect(heads).toEqual(["Todos", "Sessions", "Notes", "Pages"])
  })

  it("keeps the server's row order inside and across the groups", () => {
    renderList()

    const options = screen.getAllByRole("option")
    expect(options.map(node => node.getAttribute("data-testid"))).toEqual([
      "search-row-todo:AAA-1", "search-row-todo:AAA-2", "search-row-session:s-1",
      "search-row-note:n-1", "search-row-note:n-2", "search-row-page:p-1",
    ])
  })

  it("marks exactly the selected row", () => {
    renderList(resultRows(RESULTS), 2)

    const selected = screen.getAllByRole("option").filter(node => node.getAttribute("aria-selected") === "true")
    expect(selected.map(node => node.getAttribute("data-testid"))).toEqual(["search-row-session:s-1"])
  })

  it("opens the row that was clicked", () => {
    const { onActivate } = renderList()

    fireEvent.click(screen.getByTestId("search-row-note:n-1"))

    expect(onActivate).toHaveBeenCalledWith(expect.objectContaining({ key: "note:n-1" }))
  })

  it("highlights the title through the gateway's own marks when the words landed there", () => {
    const marked = searchResult({
      kind: "todo",
      id: "AAA-3",
      title: "Chat scroll opens at the wrong anchor",
      reason: [{ field: "title", snippet: "Chat scroll <mark>opens</mark> at the wrong anchor" }],
    })

    const { container } = renderList(resultRows([marked]))

    expect(container.querySelector("mark")?.textContent).toBe("opens")
  })

  it("says so quietly when there is nothing to show", () => {
    renderList([])

    expect(screen.getByTestId("search-list-empty").textContent).toBe("No results")
  })

  it("renders recents as their own group", () => {
    renderList(recentRows([{ id: "todo-AAA-1", label: "A row", href: "/todo/AAA-1", type: "todo" }]))

    expect(screen.getByRole("presentation").textContent).toBe("Recent")
    expect(screen.getByTestId("search-row-recent:todo-AAA-1").textContent).toContain("A row")
  })
})

describe("statusTint", () => {
  it("paints a paused session amber rather than leaving it neutral", () => {
    expect(statusTint("waiting")).toBe("var(--system-yellow)")
  })
})
