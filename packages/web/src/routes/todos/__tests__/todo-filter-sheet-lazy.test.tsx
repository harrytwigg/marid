import { render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { clearNoticeSink, registerNoticeSink } from "@/lib/notices"
import { LazyTodoFilterSheet } from "../todo-filter-sheet-lazy"

/* The mobile filter sheet loads on its first open; when its chunk cannot be fetched it closes and says so. */

vi.mock("../todo-filter-sheet", () => {
  throw new Error("Failed to fetch dynamically imported module")
})

afterEach(() => clearNoticeSink())

describe("LazyTodoFilterSheet", () => {
  it("closes the sheet and says so on the notice surface when the chunk cannot be fetched", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const notice = vi.fn()
    registerNoticeSink(notice)
    const onClose = vi.fn()

    render(
      <LazyTodoFilterSheet filters={{ status: "open" }} onChange={vi.fn()} employees={[]} departments={[]} byName={new Map()} onClose={onClose} />,
    )

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(notice).toHaveBeenCalledWith({ title: "The filter sheet couldn't load. Reload the page and try again.", level: "error" })
    expect(screen.queryByTestId("todo-filter-sheet")).toBeNull()
  })
})
