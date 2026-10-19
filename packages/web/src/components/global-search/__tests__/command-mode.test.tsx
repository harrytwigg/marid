import "@/test/preload-dialogs"
import { fireEvent, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  searchGlobal: vi.fn(),
  getWorkItem: vi.fn(),
  getWorkItemTree: vi.fn(),
  getOrg: vi.fn(),
  getDepartments: vi.fn(),
  setWorkItemStatus: vi.fn(),
  assignWorkItem: vi.fn(),
  addWorkItemComment: vi.fn(),
  createWorkItem: vi.fn(),
  triggerCronJob: vi.fn(),
}))

vi.mock("@/lib/search-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/search-api")>()
  return { ...actual, searchGlobal: mocks.searchGlobal }
})
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: { ...actual.api, ...mocks } }
})
vi.mock("@/routes/settings-provider", () => ({
  useSettings: () => ({ settings: { portalName: "Jinn", employeeOverrides: {} } }),
}))

import type { WorkItemStatusWire } from "@/lib/api"
import { renderOverlay, searchField } from "./harness"
import { searchResponse, searchResult } from "./fixtures"
import { EMPLOYEES, TODO_ID, todoDetail, treeOf } from "./workbench-harness"

/* The verbs layer. The rule it exists to keep is the first test here: a plain
 * query is a search, whatever words are in it. Everything below is what the ">"
 * that opts out of that gets you. */

const CRON_ID = "nightly-sweep"

const RESULTS = [
  searchResult({
    kind: "todo",
    id: TODO_ID,
    title: "Migrate the registry",
    preview: { title: "Migrate the registry", excerpt: "", url: `/todos/${TODO_ID}`, status: "executing" },
    url: `/todos/${TODO_ID}`,
  }),
  searchResult({
    kind: "cron",
    id: CRON_ID,
    title: "Nightly sweep",
    preview: { title: "Nightly sweep", excerpt: "", url: `/cron/${CRON_ID}`, subtitle: "every day at 03:00" },
    url: `/cron/${CRON_ID}`,
  }),
]

/** Type a query and wait for the row it is meant to surface. */
async function find(query: string) {
  fireEvent.change(searchField(), { target: { value: query } })
  return screen.findByTestId(`search-row-todo:${TODO_ID}`)
}

/** Leave a row pinned, then hand the field to a command. */
async function pin(index: number) {
  await find("match")
  for (let step = 0; step < index; step += 1) fireEvent.keyDown(searchField(), { key: "ArrowDown" })
  // The pin is read from the render before the mode flips, so let it settle.
  await screen.findByTestId(`search-row-cron:${CRON_ID}`)
}

function type(query: string) {
  fireEvent.change(searchField(), { target: { value: query } })
}

describe("the overlay's verbs layer", () => {
  beforeEach(() => {
    localStorage.clear()
    for (const mock of Object.values(mocks)) mock.mockReset()
    mocks.searchGlobal.mockResolvedValue(searchResponse({ results: RESULTS }))
    const stored = { status: "executing" as WorkItemStatusWire, assignee: "a-lead" as string | null }
    mocks.getWorkItem.mockImplementation((id: string) => Promise.resolve(todoDetail({ ...stored }, id)))
    mocks.setWorkItemStatus.mockImplementation((_id: string, status: WorkItemStatusWire) => {
      stored.status = status
      return Promise.resolve({ workItem: todoDetail({ ...stored, version: 5 }).workItem })
    })
    mocks.assignWorkItem.mockImplementation((_id: string, assignee: string) => {
      stored.assignee = assignee
      return Promise.resolve({ workItem: todoDetail({ ...stored, version: 5 }).workItem })
    })
    mocks.getWorkItemTree.mockResolvedValue(treeOf([]))
    mocks.getOrg.mockResolvedValue({ departments: ["platform"], employees: EMPLOYEES, hierarchy: { root: null, sorted: [], warnings: [] } })
    mocks.getDepartments.mockResolvedValue({ departments: [] })
    mocks.addWorkItemComment.mockResolvedValue({ comment: { id: "wic_1" } })
    mocks.createWorkItem.mockResolvedValue({ workItem: todoDetail().workItem })
    mocks.triggerCronJob.mockResolvedValue({})
  })

  it("keeps a plain query a search, even when it opens with a verb word", async () => {
    renderOverlay()
    fireEvent.change(searchField(), { target: { value: "run the migration" } })

    // The whole layering rule: results, and nothing dispatched.
    await screen.findByTestId(`search-row-cron:${CRON_ID}`)
    expect(screen.getAllByRole("option").length).toBeGreaterThan(0)
    expect(screen.queryByTestId("command-pane")).toBeNull()
    expect(mocks.triggerCronJob).not.toHaveBeenCalled()
    expect(mocks.searchGlobal).toHaveBeenCalledWith(
      expect.objectContaining({ q: "run the migration" }),
      expect.anything(),
    )
  })

  it("names the prefix and every verb before anyone has typed", () => {
    renderOverlay()
    const hint = screen.getByTestId("search-preview-hint").textContent ?? ""
    expect(hint).toContain(">")
    for (const verb of ["assign", "move", "run", "new"]) expect(hint).toContain(verb)
  })

  it("lists exactly four verbs for a bare '>'", () => {
    renderOverlay()
    type(">")
    const rows = screen.getAllByRole("option")
    expect(rows).toHaveLength(4)
    expect(rows.map(node => node.getAttribute("data-testid"))).toEqual(
      ["assign", "move", "run", "new"].map(verb => `command-row-${verb}`),
    )
  })

  it("moves the verb list with the arrows, picks with ⏎, and leaves with Esc", () => {
    renderOverlay()
    type(">")
    expect(screen.getByTestId("command-row-assign").getAttribute("aria-selected")).toBe("true")

    fireEvent.keyDown(searchField(), { key: "ArrowDown" })
    expect(screen.getByTestId("command-row-move").getAttribute("aria-selected")).toBe("true")
    fireEvent.keyDown(searchField(), { key: "ArrowUp" })
    expect(screen.getByTestId("command-row-assign").getAttribute("aria-selected")).toBe("true")

    fireEvent.keyDown(searchField(), { key: "Enter" })
    expect(searchField().value).toBe(">assign ")
    // Focus stays inside the dialog throughout.
    expect(document.querySelector("[role='dialog']")?.contains(document.activeElement)).toBe(true)

    fireEvent.keyDown(document.querySelector("[role='dialog']")!, { key: "Escape" })
    expect(searchField().value).toBe("")
    expect(screen.queryByTestId("command-pane")).toBeNull()
  })

  it("assigns the pinned Todo through the workbench's own lane", async () => {
    renderOverlay()
    await pin(0)
    type(">assign")

    expect(screen.getByTestId("command-pane").textContent).toContain("Migrate the registry")
    fireEvent.click(await screen.findByTestId("workbench-row-assignee"))
    fireEvent.click(await screen.findByTestId("assignee-option-b-lead"))

    await waitFor(() => expect(mocks.assignWorkItem).toHaveBeenCalledWith(TODO_ID, "b-lead"))
    // The new owner is on screen without anything being reloaded.
    await waitFor(() => expect(screen.getByTestId("workbench-row-assignee").textContent).toContain("B Lead"))
  })

  it("moves the pinned Todo's status, and the row it came from moves with it", async () => {
    renderOverlay()
    await pin(0)
    type(">move")

    fireEvent.click(await screen.findByTestId("workbench-row-status"))
    fireEvent.click(await screen.findByTestId("status-option-in_review"))

    await waitFor(() => expect(mocks.setWorkItemStatus).toHaveBeenCalledWith(TODO_ID, "in_review", undefined))
    // The pane's own header and its field both read the one cache the lane patched.
    await waitFor(() => expect(screen.getByTestId("command-pane").textContent).toContain("in_review"))
    // And so does the result row, once the query goes back to being a query.
    type("match")
    await waitFor(() => expect(screen.getByTestId(`search-row-todo:${TODO_ID}`).textContent).toContain("in_review"))
  })

  it("will not dispatch a cron run on ⏎ — only the confirm does that", async () => {
    renderOverlay()
    await pin(1)
    type(">run")

    const confirm = await screen.findByTestId("command-run-confirm")
    expect(confirm.textContent).toContain("Nightly sweep")

    fireEvent.keyDown(searchField(), { key: "Enter" })
    expect(mocks.triggerCronJob).not.toHaveBeenCalled()
    // ⏎ handed the confirm the focus; pressing it is the second keystroke.
    expect(document.activeElement).toBe(screen.getByTestId("command-run-now"))

    fireEvent.click(screen.getByTestId("command-run-now"))
    await waitFor(() => expect(mocks.triggerCronJob).toHaveBeenCalledWith(CRON_ID))
    expect(mocks.triggerCronJob).toHaveBeenCalledTimes(1)
    await screen.findByTestId("command-run-done")
  })

  it("opens the create dialog titled from the rest of the line", async () => {
    renderOverlay()
    type(">new some words")
    fireEvent.keyDown(searchField(), { key: "Enter" })

    const title = await screen.findByTestId("todo-new-title")
    expect((title as HTMLInputElement).value).toBe("some words")

    fireEvent.click(screen.getByTestId("todo-new-create"))
    await waitFor(() => expect(mocks.createWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({ title: "some words" }),
    ))
  })

  it("asks which Todo when the verb has no object, and goes live once told", async () => {
    renderOverlay()
    type(">assign")

    expect(screen.getByTestId("command-object-picker").textContent).toContain("Which Todo?")
    expect(screen.queryByTestId("workbench-row-assignee")).toBeNull()
    // A verb with nothing to act on is not titled after some other verb's object.
    expect(screen.getByTestId("command-pane").querySelector("h2")).toBeNull()

    fireEvent.change(screen.getByTestId("command-object-query"), { target: { value: "match" } })
    fireEvent.click(await screen.findByTestId(`search-row-todo:${TODO_ID}`))

    // Answering the question is what makes the form real.
    await screen.findByTestId("workbench-row-assignee")
    expect(screen.queryByTestId("command-object-picker")).toBeNull()
    expect(screen.getByTestId("command-pane").textContent).toContain("Migrate the registry")
  })

  it("prompts rather than acting when the pinned row is the wrong kind", async () => {
    renderOverlay()
    await pin(1)
    type(">assign")

    expect(screen.getByTestId("command-object-picker").textContent).toContain("Which Todo?")
    expect(mocks.assignWorkItem).not.toHaveBeenCalled()
  })
})
