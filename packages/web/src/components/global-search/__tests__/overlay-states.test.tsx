import "@/test/preload-dialogs"
import { fireEvent, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "@/lib/api"

const mocks = vi.hoisted(() => ({ searchGlobal: vi.fn() }))

vi.mock("@/lib/search-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/search-api")>()
  return { ...actual, searchGlobal: mocks.searchGlobal }
})
vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings: { portalName: "Jinn" } }) }))

import { renderOverlay, searchField } from "./harness"
import { searchResponse, searchResult } from "./fixtures"

const REJECTION = '"is:nonsense" is not a Todo status — drop the token, or pass literal=true to search for it as text'

function storeRecents(count: number) {
  const items = Array.from({ length: count }, (_, index) => ({
    id: `todo-AAA-${index}`, label: `Row ${index}`, href: `/todos/AAA-${index}`, type: "todo",
  }))
  localStorage.setItem("jinn-command-recent", JSON.stringify(items))
}

describe("the overlay's states", () => {
  beforeEach(() => {
    localStorage.clear()
    mocks.searchGlobal.mockReset()
    mocks.searchGlobal.mockResolvedValue(searchResponse())
  })

  it("shows a rejected query's reason verbatim, with the literal escape, and stays open", async () => {
    mocks.searchGlobal.mockRejectedValue(new ApiError(400, REJECTION))
    renderOverlay()

    fireEvent.change(searchField(), { target: { value: "is:nonsense" } })

    expect((await screen.findByTestId("search-error")).textContent).toBe(REJECTION)
    expect(screen.getByTestId("search-error-literal")).toBeTruthy()
    expect(searchField().value).toBe("is:nonsense")
  })

  it("re-runs literally from the escape the error offered", async () => {
    mocks.searchGlobal.mockRejectedValue(new ApiError(400, REJECTION))
    renderOverlay()
    fireEvent.change(searchField(), { target: { value: "is:nonsense" } })
    fireEvent.click(await screen.findByTestId("search-error-literal"))

    await waitFor(() => {
      const calls = mocks.searchGlobal.mock.calls
      expect(calls[calls.length - 1][0]).toMatchObject({ literal: true })
    })
  })

  it("says nothing matched rather than going blank", async () => {
    renderOverlay()

    fireEvent.change(searchField(), { target: { value: "nothing at all" } })

    expect((await screen.findByTestId("search-list-empty")).textContent).toBe("No results")
    expect(screen.getByTestId("search-preview-hint").textContent).toContain("Nothing matched")
  })

  it("lists at most five recents while the query is empty, and asks the gateway for nothing", async () => {
    storeRecents(7)

    renderOverlay()

    const options = await screen.findAllByRole("option")
    expect(options).toHaveLength(5)
    expect(options[0].textContent).toContain("Row 0")
    expect(mocks.searchGlobal).not.toHaveBeenCalled()
  })

  it("gives a selected recent a preview of its own", async () => {
    storeRecents(2)

    renderOverlay()

    expect((await screen.findByTestId("search-preview")).textContent).toContain("Row 0")
    expect(screen.getByTestId("search-preview").textContent?.trim()).not.toBe("")
  })

  it("falls back to a hint when nothing has been opened from here yet", async () => {
    renderOverlay()

    expect((await screen.findByTestId("search-list-empty")).textContent).toBe("Nothing opened from here yet")
    expect(screen.getByTestId("search-preview-hint").textContent).toContain("Type to search")
  })

  it("writes a recent when a row is opened by click", async () => {
    mocks.searchGlobal.mockResolvedValue(searchResponse({ results: [searchResult({ kind: "note", id: "n-1" })] }))
    renderOverlay()
    fireEvent.change(searchField(), { target: { value: "match" } })

    fireEvent.click(await screen.findByTestId("search-row-note:n-1"))

    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/note/n-1"))
    expect(JSON.parse(localStorage.getItem("jinn-command-recent") ?? "[]")[0]).toMatchObject({ id: "note-n-1" })
  })
})
