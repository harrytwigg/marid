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
import { facet, searchResponse, searchResult } from "./fixtures"

const ROW = searchResult({ kind: "todo", id: "AAA-1" })

/** `opens search blocked` — the last word is the one the grammar guessed at. */
const GUESSED = searchResponse({
  query: "opens search blocked",
  parsed: { facets: [facet({ span: { start: 13, end: 20, text: "blocked" } })], freeText: "opens search", literal: false },
  results: [ROW],
})

function lastCall() {
  return mocks.searchGlobal.mock.calls[mocks.searchGlobal.mock.calls.length - 1][0]
}

describe("the overlay's read-back of the query", () => {
  beforeEach(() => {
    localStorage.clear()
    mocks.searchGlobal.mockReset()
    mocks.searchGlobal.mockResolvedValue(GUESSED)
  })

  it("splices a dropped chip's span out of the query and asks again without it", async () => {
    renderOverlay()
    fireEvent.change(searchField(), { target: { value: "opens search blocked" } })
    const chip = await screen.findByTestId("search-facet-status")

    fireEvent.click(chip)

    await waitFor(() => expect(searchField().value).toBe("opens search"))
    await waitFor(() => expect(lastCall()).toMatchObject({ q: "opens search" }))
  })

  it("re-requests literally on ⌘⏎ and says so once the gateway agrees", async () => {
    renderOverlay()
    fireEvent.change(searchField(), { target: { value: "opens search blocked" } })
    await screen.findByTestId("search-facet-status")
    mocks.searchGlobal.mockResolvedValue(searchResponse({
      query: "opens search blocked",
      parsed: { facets: [], freeText: "opens search blocked", literal: true },
      results: [ROW],
    }))

    fireEvent.keyDown(searchField(), { key: "Enter", metaKey: true })

    await waitFor(() => expect(lastCall()).toMatchObject({ literal: true }))
    expect((await screen.findByTestId("search-readback-literal")).textContent).toBe("Read as literal text")
    expect(screen.queryByTestId("search-facet-status")).toBeNull()
  })

  it("offers the same override as a click, for anyone not reaching for ⌘⏎", async () => {
    renderOverlay()
    fireEvent.change(searchField(), { target: { value: "opens search blocked" } })

    fireEvent.click(await screen.findByTestId("search-literal-toggle"))

    await waitFor(() => expect(lastCall()).toMatchObject({ literal: true }))
  })
})

describe("the overlay opened scoped to one kind", () => {
  beforeEach(() => {
    localStorage.clear()
    mocks.searchGlobal.mockReset()
    mocks.searchGlobal.mockResolvedValue(searchResponse({ results: [ROW] }))
  })

  it("shows the kind as a pill and carries it into the request", async () => {
    renderOverlay({ initialScope: "todo" })
    expect(screen.getByTestId("search-scope-pill").textContent).toContain("Todos")

    fireEvent.change(searchField(), { target: { value: "match" } })

    await waitFor(() => expect(lastCall()).toMatchObject({ q: "match", scope: "todo" }))
  })

  it("widens back to everything when the pill is dropped", async () => {
    renderOverlay({ initialScope: "todo" })
    fireEvent.change(searchField(), { target: { value: "match" } })
    await waitFor(() => expect(lastCall()).toMatchObject({ scope: "todo" }))

    fireEvent.click(screen.getByTestId("search-scope-pill"))

    await waitFor(() => expect(lastCall().scope).toBeUndefined())
    expect(screen.queryByTestId("search-scope-pill")).toBeNull()
  })

  it("opens with the keystroke that summoned it already in the field", async () => {
    renderOverlay({ initialScope: "todo", initialQuery: "r" })
    expect(searchField().value).toBe("r")

    await waitFor(() => expect(lastCall()).toMatchObject({ q: "r", scope: "todo" }))
  })

  it("carries no pill and no scope when it opens unscoped", async () => {
    renderOverlay()
    expect(screen.queryByTestId("search-scope-pill")).toBeNull()

    fireEvent.change(searchField(), { target: { value: "match" } })

    await waitFor(() => expect(lastCall().scope).toBeUndefined())
  })
})
