import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError, type Employee, type WorkItemDetailWire, type WorkItemStatusWire } from "@/lib/api"
import { TODO_WRITE_KEY } from "@/lib/query-keys"
import { STATUS_LABEL } from "@/lib/todos"
import { useTodoById } from "../../use-todos"
import { useTodoQuickPickers, type TodoQuickPickerKey } from "../use-todo-quick-pickers"

/* The quick-picker lane's own behaviour, below any surface that hosts it: the
 * close gate it fetches on demand, the two assignment routes, and the gateway's
 * words coming back when it refuses. The surface here is the least one can be —
 * two anchor rows reading the canonical cache, and the refusal line. */

const getWorkItem = vi.fn()
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
      getWorkItemTree: (...args: unknown[]) => getWorkItemTree(...args),
      setWorkItemStatus: (...args: unknown[]) => setWorkItemStatus(...args),
      assignWorkItem: (...args: unknown[]) => assignWorkItem(...args),
      updateWorkItem: (...args: unknown[]) => updateWorkItem(...args),
    },
  }
})

const EMPLOYEES: Employee[] = [
  { name: "a-lead", displayName: "A Lead", department: "platform", rank: "senior", engine: "codex", model: "m", persona: "p" },
  { name: "b-lead", displayName: "B Lead", department: "platform", rank: "senior", engine: "codex", model: "m", persona: "p" },
]

function detailOf(id: string, status: WorkItemStatusWire = "executing"): WorkItemDetailWire {
  return {
    workItem: {
      id, version: 4, title: `Title of ${id}`, body: "", status, department: null, assignee: "a-lead",
      priority: 3, rank: null, source: "human", sourceRef: null, rounds: 0, budgetUsd: null, parentId: null,
      createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-05T00:00:00.000Z", closedAt: null,
    },
    spendUsd: 0,
    events: [],
  }
}

/** The tree behind the close gate: `openKids` children still in flight. */
function treeOf(openKids: number) {
  const node = (id: string, status: WorkItemStatusWire) => ({ ...detailOf(id, status).workItem, children: [] })
  return {
    tree: {
      root: {
        ...detailOf("ICI-1").workItem,
        children: [...Array.from({ length: openKids }, (_, i) => node(`ICI-2${i}`, "executing")), node("ICI-30", "done")],
      },
      totals: {},
      spendUsd: 0,
    },
  }
}

function Row({ property, value, row }: {
  property: TodoQuickPickerKey
  value: string
  row: ReturnType<ReturnType<typeof useTodoQuickPickers>["rowFor"]>
}) {
  return (
    <div>
      <button type="button" data-testid={`quick-row-${property}`} onClick={row.onOpen}>{value}</button>
      {row.picker}
    </div>
  )
}

function Surface() {
  const detail = useTodoById("ICI-1").data ?? undefined
  const pickers = useTodoQuickPickers({ detail, employees: EMPLOYEES, prefix: "quick" })
  if (!detail) return null
  const assignee = EMPLOYEES.find((employee) => employee.name === detail.workItem.assignee)?.displayName ?? "Unassigned"
  return (
    <>
      <Row property="status" value={STATUS_LABEL[detail.workItem.status]} row={pickers.rowFor("status")} />
      <Row property="assignee" value={assignee} row={pickers.rowFor("assignee")} />
      {pickers.refusal.message && <p data-testid="quick-refusal">{pickers.refusal.message}</p>}
    </>
  )
}

function renderSurface(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={client}><Surface /></QueryClientProvider>)
  return client
}

async function openPicker(property: TodoQuickPickerKey) {
  fireEvent.click(await screen.findByTestId(`quick-row-${property}`))
  await screen.findByTestId(property === "status" ? "status-option-done" : "assignee-option-unassign")
}

const rowText = (property: TodoQuickPickerKey) => screen.getByTestId(`quick-row-${property}`).textContent ?? ""

beforeEach(() => {
  vi.clearAllMocks()
  getWorkItem.mockImplementation((id: string) => Promise.resolve(detailOf(id)))
  getWorkItemTree.mockResolvedValue(treeOf(0))
  setWorkItemStatus.mockResolvedValue({ workItem: { ...detailOf("ICI-1").workItem, version: 5 }, escalated: false })
})

describe("quick status picker", () => {
  it("closes the sub-tasks with the parent when Done is taken", async () => {
    getWorkItemTree.mockResolvedValue(treeOf(2))
    renderSurface()
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
    renderSurface()
    fireEvent.click(await screen.findByTestId("quick-row-status"))

    expect(await screen.findByText(/sub-tasks could not be read/)).toBeTruthy()
    // Not even the ungated moves: a close the gateway would refuse must not be
    // offered as though the check had come back clean.
    expect(screen.queryByTestId("status-option-done")).toBeNull()
  })
})

describe("quick assignee picker", () => {
  it("unassigns through the conditional edit lane, carrying the item's version", async () => {
    let resolveWrite!: (value: unknown) => void
    updateWorkItem.mockImplementation(() => new Promise((resolve) => { resolveWrite = resolve }))
    const client = renderSurface()
    await openPicker("assignee")

    fireEvent.click(screen.getByTestId("assignee-option-unassign"))

    await waitFor(() => expect(rowText("assignee")).toBe("Unassigned"))
    expect(assignWorkItem).not.toHaveBeenCalled()
    expect(updateWorkItem).toHaveBeenCalledWith("ICI-1", expect.objectContaining({
      patch: { assignee: null },
      expectedVersion: 4,
    }))
    // The in-flight write holds the key a live invalidation defers behind.
    expect(client.isMutating({ mutationKey: TODO_WRITE_KEY })).toBeGreaterThan(0)

    resolveWrite({ workItem: { ...detailOf("ICI-1").workItem, version: 5, assignee: null }, replayed: false })
    await waitFor(() => expect(client.isMutating({ mutationKey: TODO_WRITE_KEY })).toBe(0))
  })

  it("rolls the name back and repeats the gateway's suggestion when the roster refuses", async () => {
    const refusal = 'unknown employee "b-lead". Did you mean "b-leed"?'
    assignWorkItem.mockRejectedValue(new ApiError(400, refusal))
    renderSurface()
    await openPicker("assignee")

    fireEvent.click(screen.getByTestId("assignee-option-b-lead"))

    await waitFor(() => expect(screen.getByTestId("quick-refusal").textContent).toBe(refusal))
    expect(rowText("assignee")).toBe("A Lead")
  })
})
