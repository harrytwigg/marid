import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  searchGlobal: vi.fn(),
  getWorkItem: vi.fn(),
  getWorkItemTree: vi.fn(),
  getOrg: vi.fn(),
  setWorkItemStatus: vi.fn(),
  assignWorkItem: vi.fn(),
  addWorkItemComment: vi.fn(),
  uploadWorkItemAttachment: vi.fn(),
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

import { ApiError, type WorkItemStatusWire } from "@/lib/api"
import type { SearchKind } from "@/lib/search-api"
import { closeGateCounts, legalTargets } from "@/lib/legal-targets"
import { StatusPickerContent } from "@/routes/todos/pickers/status-picker-content"
import { renderOverlay, searchField } from "./harness"
import { searchResponse, searchResult } from "./fixtures"
import {
  EMPLOYEES, OTHER_TODO_ID, TODO_ID, deferred, openPicker, previewText, rowText, selectRow,
  todoDetail, treeOf,
} from "./workbench-harness"

/* The overlay's write half. Every guard, every refusal string and every cache
 * these tests assert on belongs to the Todo page's own lanes — what is proved
 * here is that the workbench reaches them, and that nothing else in the overlay
 * gets to act. */

const OTHER_KINDS: SearchKind[] = ["session", "employee", "cron", "skill", "note", "page"]

const RESULTS = [
  searchResult({
    kind: "todo",
    id: TODO_ID,
    preview: { title: "First row", excerpt: "", url: `/todos/${TODO_ID}`, status: "executing" },
    url: `/todos/${TODO_ID}`,
  }),
  searchResult({
    kind: "todo",
    id: OTHER_TODO_ID,
    preview: { title: "Second row", excerpt: "", url: `/todos/${OTHER_TODO_ID}`, status: "executing" },
    url: `/todos/${OTHER_TODO_ID}`,
  }),
  ...OTHER_KINDS.map(kind => searchResult({ kind, id: `${kind}-1` })),
]

async function openOnTheTodo() {
  renderOverlay()
  fireEvent.change(searchField(), { target: { value: "match" } })
  await screen.findByTestId("search-workbench")
}

describe("the search workbench", () => {
  beforeEach(() => {
    localStorage.clear()
    for (const mock of Object.values(mocks)) mock.mockReset()
    mocks.searchGlobal.mockResolvedValue(searchResponse({ results: RESULTS }))
    // A fake with a memory: a settled write reads back as the server's truth,
    // so a value still on screen afterwards is the write's, not the fixture's.
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
    mocks.addWorkItemComment.mockResolvedValue({ comment: { id: "wic_1" } })
  })

  it("moves the status through the Todo page's own lane, and asks for the Todo again", async () => {
    await openOnTheTodo()
    await openPicker("status")

    fireEvent.click(screen.getByTestId("status-option-in_review"))

    await waitFor(() => expect(mocks.setWorkItemStatus).toHaveBeenCalledWith(TODO_ID, "in_review", undefined))
    // The settle invalidation is what spares the real Todo page a manual refresh.
    await waitFor(() => expect(mocks.getWorkItem.mock.calls.length).toBeGreaterThan(1))
    // Both surfaces read that one cache, so the move shows in both.
    await waitFor(() => expect(rowText()).toContain("in_review"))
    expect(previewText()).toContain("in_review")
  })

  it("reassigns against the live org roster", async () => {
    await openOnTheTodo()
    await openPicker("assignee")

    // The roster is the one useOrg() loaded, by display name.
    expect(screen.getByTestId("assignee-option-b-lead").textContent).toContain("B Lead")
    fireEvent.click(screen.getByTestId("assignee-option-b-lead"))

    await waitFor(() => expect(mocks.assignWorkItem).toHaveBeenCalledWith(TODO_ID, "b-lead"))
    // The chip says what the roster calls them, never the employee key.
    await waitFor(() => expect(screen.getByTestId("workbench-row-assignee").textContent).toContain("B Lead"))
    expect(screen.getByTestId("workbench-row-assignee").textContent).not.toContain("b-lead")
  })

  it("posts a comment on the selected Todo and makes its feed refetch", async () => {
    await openOnTheTodo()

    fireEvent.change(screen.getByTestId("workbench-comment"), { target: { value: "  a note  " } })
    fireEvent.click(screen.getByTestId("workbench-comment-send"))

    await waitFor(() => expect(mocks.addWorkItemComment).toHaveBeenCalledWith(TODO_ID, "a note", undefined))
    // The composer empties itself, and the Todo is asked for again — which is
    // what puts the comment in the real Activity feed with nothing else clicked.
    await waitFor(() => expect((screen.getByTestId("workbench-comment") as HTMLTextAreaElement).value).toBe(""))
    await waitFor(() => expect(mocks.getWorkItem.mock.calls.length).toBeGreaterThan(1))
  })

  it("inserts a picked @mention on Enter instead of posting", async () => {
    await openOnTheTodo()

    const field = screen.getByTestId("workbench-comment") as HTMLTextAreaElement
    fireEvent.change(field, { target: { value: "ask @b-l" } })
    fireEvent.keyDown(field, { key: "Enter" })

    expect(field.value).toBe("ask @b-lead ")
    expect(mocks.addWorkItemComment).not.toHaveBeenCalled()
  })

  it("refuses a gated move with the very string the task page refuses it with", async () => {
    // An open sub-task with a blocked one below it: cancel is gated while they stay open.
    const tree = treeOf(["executing", "blocked"])
    mocks.getWorkItemTree.mockResolvedValue(tree)
    const detail = todoDetail()

    // 1. The module both surfaces consume, given the task page's own inputs.
    const counts = closeGateCounts(tree.tree.root)
    const fromModule = legalTargets(detail.workItem.status, counts).find(target => target.status === "cancelled")

    // 2. The task page's status picker, rendered on those same inputs.
    const page = render(
      <StatusPickerContent detail={detail} {...counts} commit={vi.fn()} onDone={vi.fn()} />,
    )
    const onThePage = screen.getByTestId("status-option-cancelled")
    const pageText = onThePage.textContent
    const pageDisabled = onThePage.getAttribute("aria-disabled")
    page.unmount()

    // 3. The workbench, reached the way an operator reaches it.
    await openOnTheTodo()
    await openPicker("status")
    const inTheOverlay = screen.getByTestId("status-option-cancelled")

    expect(fromModule?.reason).toMatch(/sub-tasks? still open$/)
    expect(fromModule?.gated).toBe(true)
    expect(inTheOverlay.textContent).toBe(pageText)
    expect(inTheOverlay.textContent).toContain(fromModule?.reason)
    expect(inTheOverlay.getAttribute("aria-disabled")).toBe(pageDisabled)
  })

  it("reverts the row and the preview together when the gateway refuses, and says why", async () => {
    const refusal = deferred<never>()
    mocks.setWorkItemStatus.mockReturnValue(refusal.promise)
    await openOnTheTodo()
    // After the first read the Todo never answers again, so anything that goes
    // back to "executing" got there by rolling back rather than by refetching.
    mocks.getWorkItem.mockReturnValue(new Promise(() => {}))
    await openPicker("status")

    fireEvent.click(screen.getByTestId("status-option-in_review"))
    await waitFor(() => expect(rowText()).toContain("in_review"))
    expect(previewText()).toContain("in_review")

    refusal.reject(new ApiError(409, "Another write landed first — reopen the Todo and try again"))

    await waitFor(() => expect(screen.getByTestId("workbench-error").textContent)
      .toBe("Another write landed first — reopen the Todo and try again"))
    expect(rowText()).toContain("executing")
    expect(previewText()).toContain("executing")
  })

  it("gives all three controls to the keyboard, and keeps its keys off the result list", async () => {
    await openOnTheTodo()
    const before = previewText()

    for (const testId of ["workbench-row-status", "workbench-row-assignee", "workbench-comment"]) {
      const control = screen.getByTestId(testId)
      control.focus()
      expect(document.activeElement).toBe(control)
    }

    // ↑↓ and ⏎ struck in the composer belong to the composer.
    const composer = screen.getByTestId("workbench-comment")
    fireEvent.keyDown(composer, { key: "ArrowDown" })
    fireEvent.keyDown(composer, { key: "ArrowUp" })
    fireEvent.keyDown(composer, { key: "Enter" })
    expect(previewText()).toBe(before)
    expect(screen.getByTestId("location").textContent).toBe("/")

    // The picker opens onto its first row and ↓ walks them, all without the
    // selection behind it moving.
    await openPicker("status")
    const focused = document.activeElement as HTMLElement
    expect(focused.getAttribute("data-picker-row")).not.toBeNull()
    fireEvent.keyDown(focused, { key: "ArrowDown" })
    expect(document.activeElement).not.toBe(focused)
    expect(previewText()).toContain("First row")
  })

  it("closes an open picker when the selection moves to another Todo", async () => {
    // The overlay re-ranks its own list when a debounced result set lands, so an
    // open picker can be re-pointed at a Todo nobody opened it on. Its next
    // Enter would then write to that one.
    await openOnTheTodo()
    await openPicker("status")

    // Todo-to-Todo, so the workbench itself never unmounts on the way.
    selectRow(1)
    await waitFor(() => expect(previewText()).toContain(OTHER_TODO_ID))
    await screen.findByTestId("search-workbench")

    expect(screen.queryByTestId("workbench-picker-status")).toBeNull()
    expect(screen.queryByTestId("status-option-backlog")).toBeNull()
  })

  it("lets Escape close the picker without taking the query with it", async () => {
    await openOnTheTodo()
    await openPicker("status")

    fireEvent.keyDown(document, { key: "Escape" })

    await waitFor(() => expect(screen.queryByTestId("workbench-picker-status")).toBeNull())
    // Wave 3's Escape contract: the first one clears a non-empty query. It does
    // not get to fire on the same keypress that dismissed the picker.
    expect(searchField().value).toBe("match")
    expect(screen.getByTestId(`search-row-todo:${TODO_ID}`)).toBeTruthy()
  })

  it("lets Escape close the @mention list without closing the overlay or clearing the query", async () => {
    await openOnTheTodo()

    const field = screen.getByTestId("workbench-comment") as HTMLTextAreaElement
    fireEvent.change(field, { target: { value: "ask @b" } })
    expect(screen.getByTestId("mention-picker")).toBeTruthy()

    fireEvent.keyDown(field, { key: "Escape" })

    await waitFor(() => expect(screen.queryByTestId("mention-picker")).toBeNull())
    expect(screen.getByTestId("search-workbench")).toBeTruthy()
    expect(searchField().value).toBe("match")
    expect(field.value).toBe("ask @b")
  })

  it("gives a row of any other kind no write control at all", async () => {
    renderOverlay()
    fireEvent.change(searchField(), { target: { value: "match" } })
    await screen.findByTestId("search-workbench")

    selectRow(1) // past the second Todo
    for (let index = 1; index <= OTHER_KINDS.length; index += 1) {
      selectRow(1)
      expect(previewText()).toContain(`${OTHER_KINDS[index - 1]}-1 row`)
      expect(screen.queryByTestId("search-workbench")).toBeNull()
      expect(screen.queryByTestId("workbench-comment")).toBeNull()
    }
  })

  it("gives a recent row no write control either", async () => {
    localStorage.setItem("jinn-command-recent", JSON.stringify([
      { id: `todo-${TODO_ID}`, label: "A row", href: `/todos/${TODO_ID}`, type: "todo" },
    ]))
    renderOverlay()

    await screen.findByTestId("search-preview")
    expect(previewText()).toContain("A row")
    expect(screen.queryByTestId("search-workbench")).toBeNull()
  })
})
