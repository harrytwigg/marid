import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkItemFullWire, WorkItemTreeNodeWire } from "@/lib/api"
import type { BoardRole } from "@/lib/accounts-api"
import TaskPage from "../task-page/task-page"
import "@/test/preload-menus"

type Principal = { kind: "operator" } | { kind: "member"; user: { id: string; email: string; displayName: string }; boards: { department: string; role: BoardRole }[] }
let principal: Principal = { kind: "operator" }
vi.mock("@/routes/auth-provider", () => ({ useAuthOptional: () => ({ principal, authState: { accountsEnabled: true, principal } }) }))
vi.mock("@/components/page-layout", () => ({ PageLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }))
vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings: { employeeOverrides: {} } }) }))
vi.mock("@/routes/providers", () => ({ useTheme: () => ({ theme: "dark" }) }))

const getWorkItem = vi.fn()
const getWorkItemTree = vi.fn()
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      getWorkItem: (...a: unknown[]) => getWorkItem(...a),
      getWorkItemTree: (...a: unknown[]) => getWorkItemTree(...a),
      listWorkItemAttachments: async () => ({ attachments: [] }),
      listWorkItemComments: async () => ({ comments: [], total: 0 }),
      listWorkItemSessions: async () => [],
      workItemAttachmentUrl: () => "",
      getDepartments: async () => ({ departments: [{ slug: "platform", prefix: "PLT", createdAt: "", todoCount: 2 }] }),
      getOrg: async () => ({ departments: ["platform"], employees: [], hierarchy: { root: null, sorted: [], warnings: [] } }),
      listWorkItems: async () => ({ workItems: [], total: 0, nextOffset: null }),
    },
  }
})

function full(id: string, o: Partial<WorkItemFullWire> = {}): WorkItemFullWire {
  return {
    id, version: 3, title: `Item ${id}`, body: null, status: "backlog", department: "platform", assignee: null, priority: 2, rank: null,
    source: "connector", sourceRef: null, rounds: 0, budgetUsd: null, createdBy: "user:me", parentId: null, rootId: id, depth: 0, dueAt: null,
    createdAt: "2026-07-20T08:00:00.000Z", updatedAt: "2026-07-23T08:00:00.000Z", closedAt: null, ...o,
  }
}
const node = (item: WorkItemFullWire, children: WorkItemTreeNodeWire[] = []): WorkItemTreeNodeWire => ({ ...item, children })

function member(role: BoardRole): Principal {
  return { kind: "member", user: { id: "me", email: "me@example.test", displayName: "Mia" }, boards: [{ department: "platform", role }] }
}

function setup(root: WorkItemFullWire, children: WorkItemFullWire[] = []) {
  getWorkItem.mockResolvedValue({ workItem: root, spendUsd: 0, events: [] })
  getWorkItemTree.mockResolvedValue({ tree: { root: node(root, children.map((c) => node(c))), totals: {}, spendUsd: 0 } })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/todos/PLT-1"]}>
        <Routes><Route path="/todos/:todoId" element={<TaskPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => vi.clearAllMocks())

describe("the Todo page for a member", () => {
  it("gives a collaborator on a member-only tree edit, close, sub-tasks and comments, and none of the operator's controls", async () => {
    principal = member("collaborator")
    setup(full("PLT-1"))
    await screen.findByTestId("task-title")
    // The tree decides member-only, so the write controls arrive with it.
    expect(await screen.findByTestId("task-mark-done")).toBeTruthy()
    expect(screen.getByTestId("rail-priority").closest("button")).not.toBeNull()
    expect(screen.getByTestId("subtask-add")).toBeTruthy()
    expect(screen.getByTestId("task-composer")).toBeTruthy()
    expect(screen.getByTestId("attachment-add")).toBeTruthy()
    // The operator's lanes: properties show as plain values (no picker to open), and dispatch, auto-start and spend are gone.
    for (const id of ["rail-status", "rail-assignee", "rail-department", "rail-due", "chip-status", "chip-assignee"]) {
      const el = screen.queryByTestId(id)
      expect(el === null || el.closest("button") === null, id).toBe(true)
    }
    for (const id of ["rail-dispatch", "rail-spend", "rail-labels-add", "rail-assignee-clear"]) expect(screen.queryByTestId(id), id).toBeNull()
  })

  it("keeps a viewer read-only: no composer, no attach, no close, no sub-task add", async () => {
    principal = member("viewer")
    setup(full("PLT-1"))
    await screen.findByTestId("task-title")
    for (const id of ["task-composer", "attachment-add", "task-mark-done", "subtask-add"]) {
      expect(screen.queryByTestId(id), id).toBeNull()
    }
    // Priority is shown as a plain row, not a control that opens a picker.
    expect(screen.getByTestId("rail-priority").closest("button")).toBeNull()
    expect(screen.queryByTestId("task-title-edit")).toBeNull()
  })

  it("offers a collaborator comments but no edit or close once an employee-made Todo is in the tree", async () => {
    principal = member("collaborator")
    setup(full("PLT-1"), [full("PLT-2", { parentId: "PLT-1", createdBy: "marid-dev" })])
    await screen.findByTestId("task-title")
    expect(screen.getByTestId("task-composer")).toBeTruthy()
    await waitFor(() => expect(screen.queryByTestId("subtask-row-PLT-2")).toBeTruthy())
    for (const id of ["task-mark-done", "subtask-add"]) expect(screen.queryByTestId(id), id).toBeNull()
    expect(screen.getByTestId("rail-priority").closest("button")).toBeNull()
  })

  it("shows a 404 Todo as the not-shared page, never as missing", async () => {
    principal = member("viewer")
    getWorkItem.mockRejectedValue(Object.assign(new Error("not found"), { status: 404 }))
    getWorkItemTree.mockRejectedValue(Object.assign(new Error("not found"), { status: 404 }))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/todos/PLT-9"]}><Routes><Route path="/todos/:todoId" element={<TaskPage />} /></Routes></MemoryRouter>
      </QueryClientProvider>,
    )
    expect(await screen.findByText(/isn't shared with you/i)).toBeTruthy()
  })

  it("leaves the operator's page as it was", async () => {
    principal = { kind: "operator" }
    setup(full("PLT-1", { createdBy: "operator" }))
    await screen.findByTestId("task-title")
    for (const id of ["rail-status", "rail-assignee", "rail-dispatch", "rail-spend", "task-composer", "chip-status"]) {
      await waitFor(() => expect(screen.getByTestId(id), id).toBeTruthy())
    }
    expect(screen.queryByTestId("task-mark-done")).toBeNull()
  })
})
