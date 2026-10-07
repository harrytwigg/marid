import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError, type WorkItemDetailWire, type WorkItemFullWire, type WorkItemTreeNodeWire } from "@/lib/api"
import TaskPage from "../task-page/task-page"

/* Todos v2 slice 6 — the property pickers (design-doc §7.3, polish laws 1–3,
 * 20): ONE legality truth (legalTargets) in the status picker — illegal edges
 * ABSENT, gated targets disabled at 50% with the inline reason and a quiet
 * omission footnote; NSMenu superimposition (the current value's row sits over
 * the anchor); optimistic commits that snap back with the gateway's words. */

vi.mock("@/components/page-layout", () => ({ PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings: { employeeOverrides: {} } }) }))
vi.mock("@/routes/providers", () => ({ useTheme: () => ({ theme: "dark" }) }))

const getWorkItem = vi.fn()
const getWorkItemTree = vi.fn()
const setWorkItemStatus = vi.fn()
const updateWorkItem = vi.fn()
const assignWorkItem = vi.fn()
const setWorkItemLabels = vi.fn()
const listLabels = vi.fn()

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      getWorkItem: (...args: unknown[]) => getWorkItem(...args),
      getWorkItemTree: (...args: unknown[]) => getWorkItemTree(...args),
      setWorkItemStatus: (...args: unknown[]) => setWorkItemStatus(...args),
      updateWorkItem: (...args: unknown[]) => updateWorkItem(...args),
      assignWorkItem: (...args: unknown[]) => assignWorkItem(...args),
      setWorkItemLabels: (...args: unknown[]) => setWorkItemLabels(...args),
      listLabels: (...args: unknown[]) => listLabels(...args),
      listWorkItemSessions: vi.fn().mockResolvedValue([]),
      getDepartments: vi.fn().mockResolvedValue({
        departments: [
          { slug: "platform", prefix: "PLA", createdAt: "2026-07-01T00:00:00.000Z", todoCount: 4 },
          { slug: "marketing", prefix: "MKT", createdAt: "2026-07-01T00:00:00.000Z", todoCount: 2 },
        ],
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
    assignee: null, priority: 2, rank: null, source: "human", sourceRef: null,
    rounds: 1, budgetUsd: null,
    createdBy: "operator", parentId: null, rootId: id, depth: 0,
    dueAt: null, createdAt: "2026-07-20T08:00:00.000Z", updatedAt: "2026-07-23T08:00:00.000Z",
    closedAt: null, ...overrides,
  }
}

function detailOf(item: WorkItemFullWire, extra: Partial<WorkItemDetailWire> = {}): WorkItemDetailWire {
  return { workItem: item, spendUsd: 0, events: [], ...extra }
}

function treeNode(item: WorkItemFullWire, children: WorkItemTreeNodeWire[] = []): WorkItemTreeNodeWire {
  return { ...item, children }
}

function renderTask(path = "/todos/PLA-12") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/todos/:todoId" element={<TaskPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  listLabels.mockResolvedValue({ labels: [
    { id: "lab_1", name: "store", color: "#7DBE6A", department: null, createdAt: "2026-07-01T00:00:00.000Z" },
    { id: "lab_2", name: "infra", color: "#5B9BD5", department: null, createdAt: "2026-07-01T00:00:00.000Z" },
  ] })
  getWorkItemTree.mockImplementation((id: string) =>
    Promise.resolve({ tree: { root: treeNode(full(id)), totals: {}, spendUsd: 0 } }),
  )
})

describe("the status picker", () => {
  it("offers ONLY the legal manual targets from in review — illegal edges are absent, with the omission footnote", async () => {
    getWorkItem.mockResolvedValue(detailOf(full("PLA-12", { status: "in_review" })))
    renderTask()
    fireEvent.click(await screen.findByTestId("rail-status"))

    const picker = await screen.findByTestId("picker-status")
    // Current first (checked), then the design's presentation order (F2):
    // In progress (sending it back) · Done · Blocked · Cancelled.
    const rows = [...picker.querySelectorAll<HTMLElement>('[data-testid^="status-option-"]')]
    expect(rows.map((row) => row.dataset.testid)).toEqual([
      "status-option-in_review",
      "status-option-executing",
      "status-option-done",
      "status-option-blocked",
      "status-option-cancelled",
    ])
    expect(screen.queryByTestId("status-option-backlog")).toBeNull()
    expect(picker.textContent).toContain("Only legal moves are listed")
    expect(picker.textContent).toContain("To do isn't reachable from In review")
  })

  it("renders a gated Cancelled disabled with the inline reason while a sub-task is open, and refuses the click", async () => {
    const item = full("PLA-12")
    getWorkItem.mockResolvedValue(detailOf(item))
    getWorkItemTree.mockResolvedValue({ tree: { root: treeNode(item, [
      treeNode(full("PLA-13", { status: "blocked", parentId: "PLA-12", depth: 1 })),
      treeNode(full("PLA-14", { status: "done", parentId: "PLA-12", depth: 1 })),
    ]), totals: {}, spendUsd: 0 } })
    renderTask()
    fireEvent.click(await screen.findByTestId("rail-status"))

    const cancelled = await screen.findByTestId("status-option-cancelled")
    expect(cancelled.getAttribute("aria-disabled")).toBe("true")
    expect(cancelled.textContent).toContain("1 sub-task still open")
    fireEvent.click(cancelled)
    expect(setWorkItemStatus).not.toHaveBeenCalled()
  })

  it("closes the whole tree in one move: Done stays live with open sub-tasks and commits the cascade", async () => {
    const item = full("PLA-12")
    getWorkItem.mockResolvedValue(detailOf(item))
    getWorkItemTree.mockResolvedValue({ tree: { root: treeNode(item, [
      treeNode(full("PLA-13", { status: "executing", parentId: "PLA-12", depth: 1 }), [
        treeNode(full("PLA-15", { status: "backlog", parentId: "PLA-13", depth: 2 })),
      ]),
      treeNode(full("PLA-14", { status: "done", parentId: "PLA-12", depth: 1 })),
    ]), totals: {}, spendUsd: 0 } })
    setWorkItemStatus.mockResolvedValue({ workItem: full("PLA-12", { status: "done", version: 4 }), escalated: false })
    renderTask()
    fireEvent.click(await screen.findByTestId("rail-status"))

    const done = await screen.findByTestId("status-option-done")
    expect(done.getAttribute("aria-disabled")).toBeNull()
    // The count is the whole open subtree, not the one child directly below it.
    expect(done.textContent).toContain("also closes 2 open sub-tasks")
    fireEvent.click(done)
    await waitFor(() => expect(setWorkItemStatus).toHaveBeenCalledWith("PLA-12", "done", undefined, undefined, { cascade: true }))
  })

  it("commits optimistically and snaps back with the gateway's words on refusal", async () => {
    getWorkItem.mockResolvedValue(detailOf(full("PLA-12")))
    setWorkItemStatus.mockRejectedValue(new ApiError(403, "3 sub-tasks still open"))
    renderTask()
    fireEvent.click(await screen.findByTestId("rail-status"))
    fireEvent.click(await screen.findByTestId("status-option-in_review"))

    // Optimistic: the rail row reads the new value before the server answers.
    await waitFor(() => expect(screen.getByTestId("rail-status").textContent).toContain("In review"))
    await waitFor(() => expect(setWorkItemStatus).toHaveBeenCalledWith("PLA-12", "in_review", undefined))
    await waitFor(() => expect(screen.getByTestId("task-callout").textContent).toContain("3 sub-tasks still open"))
  })

  it("superimposes the anchor NSMenu-style: current row first, menu offset -7px, width 314", async () => {
    getWorkItem.mockResolvedValue(detailOf(full("PLA-12")))
    renderTask()
    fireEvent.click(await screen.findByTestId("rail-status"))
    const picker = await screen.findByTestId("picker-status")
    expect(picker.style.top).toBe("-7px")
    expect(picker.style.left).toBe("-6px")
    expect(picker.className).toContain("w-[314px]")
  })
})

describe("the other pickers", () => {
  it("priority superimposes the CURRENT row over the anchor (Medium = index 1 → -43px) and commits a PATCH", async () => {
    const item = full("PLA-12", { priority: 2 })
    getWorkItem.mockResolvedValue(detailOf(item))
    updateWorkItem.mockResolvedValue({ workItem: { ...item, priority: 3, version: 4 }, replayed: false })
    renderTask()
    fireEvent.click(await screen.findByTestId("rail-priority"))

    const picker = await screen.findByTestId("picker-priority")
    expect(picker.style.top).toBe("-43px")
    fireEvent.click(screen.getByTestId("priority-option-3"))
    await waitFor(() => expect(updateWorkItem).toHaveBeenCalledWith("PLA-12", expect.objectContaining({ patch: { priority: 3 }, expectedVersion: 3 })))
  })

  it("assignee search filters the roster; naming someone ASSIGNS, Unassign commits null through the pen", async () => {
    const item = full("PLA-12", { assignee: "mason" })
    getWorkItem.mockResolvedValue(detailOf(item))
    assignWorkItem.mockResolvedValue({ workItem: { ...item, assignee: "scout", version: 4 } })
    updateWorkItem.mockResolvedValue({ workItem: { ...item, assignee: null, version: 4 }, replayed: false })
    renderTask()
    fireEvent.click(await screen.findByTestId("rail-assignee"))

    const search = await screen.findByTestId("assignee-search")
    fireEvent.change(search, { target: { value: "sco" } })
    expect(screen.queryByTestId("assignee-option-mason")).toBeNull()
    expect(screen.getByTestId("assignee-option-scout")).toBeTruthy()

    // Granting ownership is the assign lane's: roster check, status unchanged, notify.
    fireEvent.click(screen.getByTestId("assignee-option-scout"))
    await waitFor(() => expect(assignWorkItem).toHaveBeenCalledWith("PLA-12", "scout"))
    expect(updateWorkItem).not.toHaveBeenCalled()

    // Only "nobody" goes through the pen: /assign cannot express it.
    fireEvent.click(await screen.findByTestId("rail-assignee"))
    fireEvent.click(await screen.findByTestId("assignee-option-unassign"))
    await waitFor(() => expect(updateWorkItem).toHaveBeenCalledWith("PLA-12", expect.objectContaining({ patch: { assignee: null }, expectedVersion: 3 })))
  })

  it("labels multi-select PUTs the replaced set", async () => {
    const item = full("PLA-12")
    getWorkItem.mockResolvedValue(detailOf(item, { labels: [
      { id: "lab_1", name: "store", color: "#7DBE6A", department: null, createdAt: "2026-07-01T00:00:00.000Z" },
    ] }))
    setWorkItemLabels.mockResolvedValue({ labels: [] })
    renderTask()
    fireEvent.click(await screen.findByTestId("rail-labels-add"))

    const infra = await screen.findByTestId("label-option-lab_2")
    fireEvent.click(infra)
    await waitFor(() =>
      expect(setWorkItemLabels).toHaveBeenCalledWith("PLA-12", expect.arrayContaining(["lab_1", "lab_2"])),
    )
  })

  it("the rail has no review-policy row to open", async () => {
    getWorkItem.mockResolvedValue(detailOf(full("PLA-12", { rounds: 2 })))
    renderTask()
    await screen.findByTestId("rail-due")
    expect(screen.queryByTestId("rail-verify")).toBeNull()
    expect(screen.getByTestId("task-props-rail").textContent).not.toMatch(/Review policy|Round \d+ of/)
  })

  it("the due picker commits an ISO day and can clear", async () => {
    const item = full("PLA-12", { dueAt: "2026-08-08T12:00:00.000Z" })
    getWorkItem.mockResolvedValue(detailOf(item))
    updateWorkItem.mockResolvedValue({ workItem: { ...item, version: 4 }, replayed: false })
    renderTask()
    fireEvent.click(await screen.findByTestId("rail-due"))

    fireEvent.click(await screen.findByTestId("due-day-9"))
    await waitFor(() => expect(updateWorkItem).toHaveBeenCalled())
    const [, request] = updateWorkItem.mock.calls[0]
    expect(request.patch.dueAt).toContain("2026-08-09")
  })

  it("the start picker commits startAt on its own row, beside the due date", async () => {
    const item = full("PLA-12", { startAt: "2026-08-03T12:00:00.000Z", dueAt: "2026-08-08T12:00:00.000Z" })
    getWorkItem.mockResolvedValue(detailOf(item))
    updateWorkItem.mockResolvedValue({ workItem: { ...item, version: 4 }, replayed: false })
    renderTask()
    expect((await screen.findByTestId("rail-start")).textContent).toContain("Starts Aug 3")
    fireEvent.click(screen.getByTestId("rail-start"))
    fireEvent.click(await screen.findByTestId("start-day-4"))
    await waitFor(() => expect(updateWorkItem).toHaveBeenCalled())
    expect(updateWorkItem.mock.calls[0][1].patch).toEqual({ startAt: expect.stringContaining("2026-08-04") })
  })

  it("department rows carry the mono prefix and the birth-prefix footnote", async () => {
    getWorkItem.mockResolvedValue(detailOf(full("PLA-12")))
    renderTask()
    fireEvent.click(await screen.findByTestId("rail-department"))

    const picker = await screen.findByTestId("picker-department")
    expect(picker.textContent).toContain("PLA")
    expect(picker.textContent).toContain("MKT")
    expect(picker.textContent).toContain("keeps its birth prefix")
  })

  it("Esc closes the picker and returns focus to the rail row", async () => {
    getWorkItem.mockResolvedValue(detailOf(full("PLA-12")))
    renderTask()
    const row = await screen.findByTestId("rail-status")
    fireEvent.click(row)
    const picker = await screen.findByTestId("picker-status")
    fireEvent.keyDown(picker, { key: "Escape" })
    await waitFor(() => expect(screen.queryByTestId("picker-status")).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("rail-status")))
  })
})
