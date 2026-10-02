import { fireEvent, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "@/lib/api"
import { legalTargets } from "@/lib/legal-targets"
import { STATUS_LABEL } from "@/lib/todos"
import { TODO_WRITE_KEY } from "@/lib/query-keys"
import { detailOf } from "./peek-fixtures"
import {
  assigneeRowText,
  atSheetBreakpoint,
  openPanel,
  openPicker,
  renderChat,
  restoreBreakpoint,
  statusRowText,
  treeOf,
} from "./peek-actions-harness"

/* ICI-743 — the peek rail's quick actions. The pickers are the task page's, so
 * what is proved here is the wiring: one write per choice, the row moving before
 * the gateway answers, the gateway's own words when it refuses, and the phone
 * stacking that puts the picker above the panel it was opened from. */

const getWorkItem = vi.fn()
const getWorkItems = vi.fn()
const getWorkItemTree = vi.fn()
const setWorkItemStatus = vi.fn()
const assignWorkItem = vi.fn()
const updateWorkItem = vi.fn()

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      ...actual.api,
      getWorkItem: (...args: unknown[]) => getWorkItem(...args),
      getWorkItems: (...args: unknown[]) => getWorkItems(...args),
      getWorkItemTree: (...args: unknown[]) => getWorkItemTree(...args),
      setWorkItemStatus: (...args: unknown[]) => setWorkItemStatus(...args),
      assignWorkItem: (...args: unknown[]) => assignWorkItem(...args),
      updateWorkItem: (...args: unknown[]) => updateWorkItem(...args),
      getOrg: () => Promise.resolve({
        departments: ["platform"],
        employees: [
          { name: "a-lead", displayName: "A Lead", department: "platform", rank: "senior", engine: "codex", model: "m", persona: "p" },
          { name: "b-lead", displayName: "B Lead", department: "platform", rank: "senior", engine: "codex", model: "m", persona: "p" },
        ],
        hierarchy: { root: null, sorted: [], warnings: [] },
      }),
    },
  }
})

vi.mock("@/hooks/use-gateway", () => ({
  useGateway: () => ({ connectionSeq: 1, subscribe: () => () => {} }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  getWorkItem.mockImplementation((id: string) => Promise.resolve(detailOf(id)))
  getWorkItems.mockImplementation((ids: string[]) =>
    Promise.resolve({ workItems: ids.map((id) => ({ workItem: { id, title: `Title of ${id}` }, events: [] })) }))
  getWorkItemTree.mockResolvedValue(treeOf(0))
  setWorkItemStatus.mockResolvedValue({ workItem: { ...detailOf("ICI-1").workItem, version: 5 }, escalated: false })
  assignWorkItem.mockResolvedValue({ workItem: { ...detailOf("ICI-1").workItem, version: 5, assignee: "b-lead" } })
  updateWorkItem.mockResolvedValue({ workItem: { ...detailOf("ICI-1").workItem, version: 5, assignee: null }, replayed: false })
})

afterEach(restoreBreakpoint)

describe("peek status quick action", () => {
  it("writes the chosen transition once and moves the row before the gateway answers", async () => {
    let resolveWrite!: (value: unknown) => void
    setWorkItemStatus.mockImplementation(() => new Promise((resolve) => { resolveWrite = resolve }))
    renderChat()
    await openPanel()
    await openPicker("status")

    fireEvent.click(screen.getByTestId("status-option-in_review"))

    await waitFor(() => expect(statusRowText()).toContain("In review"))
    expect(setWorkItemStatus).toHaveBeenCalledTimes(1)
    // The third argument is the optional transition note, which the peek has no
    // affordance for; the route omits it from the body when it is undefined.
    expect(setWorkItemStatus).toHaveBeenCalledWith("ICI-1", "in_review", undefined)

    resolveWrite({ workItem: { ...detailOf("ICI-1").workItem, version: 5, status: "in_review" }, escalated: false })
    await waitFor(() => expect(statusRowText()).toContain("In review"))
  })

  it("offers exactly the legal targets, and nothing outside them", async () => {
    getWorkItem.mockImplementation((id: string) => Promise.resolve(detailOf(id, { status: "in_review" })))
    renderChat()
    await openPanel()
    await openPicker("status")

    const offered = legalTargets("in_review", { openChildren: 0 })
      .filter((target) => target.status !== "in_review")
      .map((target) => `status-option-${target.status}`)
    const rendered = screen.getAllByRole("menuitem").map((row) => row.getAttribute("data-testid"))
    expect(rendered.sort()).toEqual([...offered].sort())
    // Including the current value: the rail's menu is moves, and staying put is
    // not one of them.
    expect(screen.queryByTestId("status-option-in_review")).toBeNull()
  })

  it("keeps a close-gated target visible but disabled, with the gateway's reason", async () => {
    getWorkItemTree.mockResolvedValue(treeOf(2))
    renderChat()
    await openPanel()
    await openPicker("status")

    const cancelled = screen.getByTestId("status-option-cancelled")
    expect(cancelled.getAttribute("aria-disabled")).toBe("true")
    expect(cancelled.textContent).toContain("2 sub-tasks still open")

    fireEvent.click(cancelled)
    expect(setWorkItemStatus).not.toHaveBeenCalled()
  })

  it("closes the sub-tasks with the parent when Done is taken from the rail", async () => {
    getWorkItemTree.mockResolvedValue(treeOf(2))
    renderChat()
    await openPanel()
    await openPicker("status")

    const done = screen.getByTestId("status-option-done")
    expect(done.getAttribute("aria-disabled")).toBeNull()
    expect(done.textContent).toContain("also closes 2 open sub-tasks")

    fireEvent.click(done)
    await waitFor(() =>
      expect(setWorkItemStatus).toHaveBeenCalledWith("ICI-1", "done", undefined, undefined, { cascade: true }),
    )
  })

  it("says the sub-task read failed rather than counting the children as none", async () => {
    getWorkItemTree.mockRejectedValue(new ApiError(503, "the tree is unavailable"))
    renderChat()
    await openPanel()
    fireEvent.click(screen.getByTestId("peek-row-status"))

    expect(await screen.findByText(/sub-tasks could not be read/)).toBeTruthy()
    // Not even the ungated moves: a close the gateway would refuse must not be
    // offered as though the check had come back clean.
    expect(screen.queryByTestId("status-option-done")).toBeNull()
  })

  it("returns the row to its previous status and says why the gateway refused", async () => {
    // A refusal with no mapped code, so what the operator reads is the gateway's
    // own sentence rather than a house translation of it.
    const refusal = "the dispatcher is holding this Todo"
    setWorkItemStatus.mockRejectedValue(new ApiError(403, refusal))
    renderChat()
    await openPanel()
    await openPicker("status")

    fireEvent.click(screen.getByTestId("status-option-in_review"))

    await waitFor(() => expect(screen.getByTestId("peek-action-error").textContent).toBe(refusal))
    expect(statusRowText()).toContain("In progress")
  })
})

describe("peek assignee quick action", () => {
  it("assigns through the roster-validated route and shows the new name at once", async () => {
    let resolveWrite!: (value: unknown) => void
    assignWorkItem.mockImplementation(() => new Promise((resolve) => { resolveWrite = resolve }))
    const client = renderChat()
    await openPanel()
    await openPicker("assignee")

    fireEvent.click(screen.getByTestId("assignee-option-b-lead"))

    await waitFor(() => expect(assigneeRowText()).toContain("B Lead"))
    expect(assignWorkItem).toHaveBeenCalledWith("ICI-1", "b-lead")
    // The in-flight write holds the key use-query-invalidation defers behind, so
    // a live company:changed cannot land on top of the optimistic value.
    expect(client.isMutating({ mutationKey: TODO_WRITE_KEY })).toBeGreaterThan(0)

    resolveWrite({ workItem: { ...detailOf("ICI-1").workItem, version: 5, assignee: "b-lead" } })
    await waitFor(() => expect(client.isMutating({ mutationKey: TODO_WRITE_KEY })).toBe(0))
  })

  it("unassigns through the conditional edit lane, carrying the item's version", async () => {
    let resolveWrite!: (value: unknown) => void
    updateWorkItem.mockImplementation(() => new Promise((resolve) => { resolveWrite = resolve }))
    const client = renderChat()
    await openPanel()
    await openPicker("assignee")

    fireEvent.click(screen.getByTestId("assignee-option-unassign"))

    await waitFor(() => expect(assigneeRowText()).toContain("Unassigned"))
    expect(assignWorkItem).not.toHaveBeenCalled()
    expect(updateWorkItem).toHaveBeenCalledWith("ICI-1", expect.objectContaining({
      patch: { assignee: null },
      expectedVersion: 4,
    }))
    expect(client.isMutating({ mutationKey: TODO_WRITE_KEY })).toBeGreaterThan(0)

    resolveWrite({ workItem: { ...detailOf("ICI-1").workItem, version: 5, assignee: null }, replayed: false })
    await waitFor(() => expect(client.isMutating({ mutationKey: TODO_WRITE_KEY })).toBe(0))
  })

  it("rolls the name back and repeats the gateway's suggestion when the roster refuses", async () => {
    const refusal = 'unknown employee "b-lead". Did you mean "b-leed"?'
    assignWorkItem.mockRejectedValue(new ApiError(400, refusal))
    renderChat()
    await openPanel()
    await openPicker("assignee")

    fireEvent.click(screen.getByTestId("assignee-option-b-lead"))

    await waitFor(() => expect(screen.getByTestId("peek-action-error").textContent).toBe(refusal))
    expect(assigneeRowText()).toContain("A Lead")
  })
})

describe("peek pickers on the phone", () => {
  it("puts the picker sheet above the peek sheet and lets Escape close it first", async () => {
    atSheetBreakpoint()
    renderChat()
    await openPanel()
    expect(screen.getByTestId("peek-sheet")).toBeTruthy()

    fireEvent.click(screen.getByTestId("peek-row-status"))
    const picker = await screen.findByTestId("peek-picker-sheet-status")
    const peekLayer = screen.getByTestId("peek-sheet").parentElement
    expect(peekLayer?.className).toContain("z-[100]")
    expect(picker.parentElement?.className).toContain("z-[120]")

    // From outside the picker's own subtree, which is where the key actually
    // arrives: the sheet pulls no focus, so nothing inside it is the target.
    fireEvent.keyDown(document.body, { key: "Escape" })

    await waitFor(() => expect(screen.queryByTestId("peek-picker-sheet-status")).toBeNull())
    expect(screen.getByTestId("peek-sheet")).toBeTruthy()

    fireEvent.keyDown(document, { key: "Escape" })
    await waitFor(() => expect(screen.queryByTestId("peek-sheet")).toBeNull())
  })

  it("stands the sheet's Tab ring down while a picker is open above it", async () => {
    atSheetBreakpoint()
    renderChat()
    await openPanel()
    fireEvent.click(screen.getByTestId("peek-row-status"))
    await screen.findByTestId("peek-picker-sheet-status")

    const dismiss = screen.getByRole("button", { name: "Dismiss" })
    dismiss.focus()
    fireEvent.keyDown(dismiss, { key: "Tab", shiftKey: true })

    expect(document.activeElement).toBe(dismiss)
  })
})

describe("peek read-only properties", () => {
  it("leaves Priority and Parent without a picker", async () => {
    renderChat()
    await openPanel()

    for (const property of ["priority", "parent"]) {
      expect(screen.getByTestId(`peek-prop-${property}`).querySelector("[aria-haspopup]")).toBeNull()
    }
    expect(screen.getByTestId("peek-prop-status").querySelector("[aria-haspopup]")).toBeTruthy()
    expect(screen.getByText(STATUS_LABEL.executing)).toBeTruthy()
  })
})
