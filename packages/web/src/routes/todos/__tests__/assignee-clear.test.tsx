import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkItemDetailWire, WorkItemFullWire, WorkItemTreeNodeWire } from "@/lib/api"
import TaskPage from "../task-page/task-page"

/* Dropping an assignee is a one-tap action, not a scroll to the bottom of the
 * roster: Unassign is pinned above the people, and both surfaces that show an
 * assignee (the properties rail, the chip cluster) carry their own × that
 * commits through the picker's exact lane. */

vi.mock("@/components/page-layout", () => ({ PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings: { employeeOverrides: {} } }) }))
vi.mock("@/routes/providers", () => ({ useTheme: () => ({ theme: "dark" }) }))

const getWorkItem = vi.fn()
const getWorkItemTree = vi.fn()
const updateWorkItem = vi.fn()
const assignWorkItem = vi.fn().mockResolvedValue({ workItem: {} })

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      getWorkItem: (...args: unknown[]) => getWorkItem(...args),
      getWorkItemTree: (...args: unknown[]) => getWorkItemTree(...args),
      updateWorkItem: (...args: unknown[]) => updateWorkItem(...args),
      assignWorkItem: (...args: unknown[]) => assignWorkItem(...args),
      setWorkItemStatus: vi.fn(),
      setWorkItemLabels: vi.fn(),
      listLabels: vi.fn().mockResolvedValue({ labels: [] }),
      listWorkItemSessions: vi.fn().mockResolvedValue([]),
      getDepartments: vi.fn().mockResolvedValue({
        departments: [{ slug: "platform", prefix: "PLA", createdAt: "2026-07-01T00:00:00.000Z", todoCount: 4 }],
      }),
      getOrg: vi.fn().mockResolvedValue({
        departments: ["platform"],
        employees: [
          { name: "mason", displayName: "Mason", department: "platform", rank: "senior", engine: "codex", model: "m", persona: "p" },
          { name: "scout", displayName: "Scout", department: "marketing", rank: "employee", engine: "codex", model: "m", persona: "p" },
        ],
        hierarchy: { root: null, sorted: [], warnings: [] },
      }),
      listWorkItems: vi.fn().mockResolvedValue({ workItems: [], total: 0, nextOffset: null }),
    },
  }
})

function full(id: string, overrides: Partial<WorkItemFullWire> = {}): WorkItemFullWire {
  return {
    id, version: 3, title: `Item ${id}`, body: null, status: "executing", department: "platform",
    assignee: null, priority: 2, rank: null, source: "human", sourceRef: null, acceptance: null,
    verifyPolicy: null, rounds: 1, budgetUsd: null, approvalState: null, approvalRequest: null,
    approvalRef: null, approvalTarget: null, approvalEscalatedAt: null, approvalDecidedBy: null,
    approvalDecidedAt: null, createdBy: "operator", parentId: null, rootId: id, depth: 0,
    dueAt: null, createdAt: "2026-07-20T08:00:00.000Z", updatedAt: "2026-07-23T08:00:00.000Z",
    closedAt: null, ...overrides,
  }
}

function detailOf(item: WorkItemFullWire): WorkItemDetailWire {
  return { workItem: item, spendUsd: 0, events: [] }
}

function treeNode(item: WorkItemFullWire, children: WorkItemTreeNodeWire[] = []): WorkItemTreeNodeWire {
  return { ...item, children }
}

function renderTask() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/todos/PLA-12"]}>
        <Routes>
          <Route path="/todos/:todoId" element={<TaskPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  getWorkItemTree.mockImplementation((id: string) =>
    Promise.resolve({ tree: { root: treeNode(full(id)), totals: {}, spendUsd: 0 } }),
  )
})

describe("the assignee picker's Unassign row", () => {
  it("sits above every person, out of the roster's scroller, and is absent when nobody is assigned", async () => {
    getWorkItem.mockResolvedValue(detailOf(full("PLA-12", { assignee: "mason" })))
    const assigned = renderTask()
    fireEvent.click(await screen.findByTestId("rail-assignee"))

    const picker = await screen.findByTestId("picker-assignee")
    const rows = [...picker.querySelectorAll<HTMLElement>('[data-testid^="assignee-option-"]')]
    expect(rows.map((row) => row.dataset.testid)).toEqual([
      "assignee-option-unassign",
      "assignee-option-operator",
      "assignee-option-mason",
      "assignee-option-scout",
    ])
    // Outside the roster's scroll container: a long roster can never push it
    // out of reach, in the popover or in the sheet.
    expect(rows[0].parentElement).not.toBe(rows[1].parentElement)
    assigned.unmount()

    getWorkItem.mockResolvedValue(detailOf(full("PLA-12")))
    renderTask()
    fireEvent.click(await screen.findByTestId("rail-assignee"))
    await screen.findByTestId("assignee-option-mason")
    expect(screen.queryByTestId("assignee-option-unassign")).toBeNull()
  })
})

describe("clearing the assignee without opening a picker", () => {
  it("the rail's clear control commits the same null the picker's Unassign does", async () => {
    const item = full("PLA-12", { assignee: "mason" })
    getWorkItem.mockResolvedValue(detailOf(item))
    updateWorkItem.mockResolvedValue({ workItem: { ...item, assignee: null, version: 4 }, replayed: false })
    renderTask()

    const clear = await screen.findByTestId("rail-assignee-clear")
    expect(clear.getAttribute("aria-label")).toBe("Remove assignee")
    clear.focus()
    expect(document.activeElement).toBe(clear)

    fireEvent.click(clear)
    await waitFor(() =>
      expect(updateWorkItem).toHaveBeenCalledWith("PLA-12", expect.objectContaining({
        patch: { assignee: null },
        expectedVersion: 3,
      })),
    )
  })

  it("the chip's clear control commits it too, and both vanish once nobody is assigned", async () => {
    const item = full("PLA-12", { assignee: "mason" })
    const cleared = { ...item, assignee: null, version: 4 }
    // First load is assigned; every refetch after the gateway accepts the clear
    // returns the unassigned Todo, so this also proves the clear survives one.
    getWorkItem.mockResolvedValueOnce(detailOf(item))
    getWorkItem.mockResolvedValue(detailOf(cleared))
    updateWorkItem.mockResolvedValue({ workItem: cleared, replayed: false })
    renderTask()

    const clear = await screen.findByTestId("chip-assignee-clear")
    expect(clear.getAttribute("aria-label")).toBe("Remove assignee")
    fireEvent.click(clear)
    await waitFor(() =>
      expect(updateWorkItem).toHaveBeenCalledWith("PLA-12", expect.objectContaining({
        patch: { assignee: null },
        expectedVersion: 3,
      })),
    )
    await waitFor(() => expect(screen.queryByTestId("chip-assignee-clear")).toBeNull())
    expect(screen.queryByTestId("rail-assignee-clear")).toBeNull()
  })

  it("offers nothing to clear when nobody is assigned", async () => {
    getWorkItem.mockResolvedValue(detailOf(full("PLA-12")))
    renderTask()

    await screen.findByTestId("rail-assignee")
    expect(screen.queryByTestId("rail-assignee-clear")).toBeNull()
    expect(screen.queryByTestId("chip-assignee-clear")).toBeNull()
  })
})

describe("the operator as an assignee", () => {
  it("offers 'You (operator)' and posts the reserved value", async () => {
    getWorkItem.mockResolvedValue(detailOf(full("PLA-12")))
    renderTask()
    fireEvent.click(await screen.findByTestId("rail-assignee"))
    const option = await screen.findByTestId("assignee-option-operator")
    expect(option.textContent).toContain("You (operator)")
    fireEvent.click(option)
    await waitFor(() => expect(assignWorkItem).toHaveBeenCalledWith("PLA-12", "@operator"))
  })

  it("shows the reserved value as You", async () => {
    getWorkItem.mockResolvedValue(detailOf(full("PLA-12", { assignee: "@operator" })))
    renderTask()
    expect((await screen.findByTestId("rail-assignee")).textContent).toContain("You")
  })
})
