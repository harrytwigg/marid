import "@/test/preload-dialogs"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkItemCompactWire } from "@/lib/api"
import type { BoardRole } from "@/lib/accounts-api"
import TodoBoardPage from "../board/board-page"
import { clearBoardScrollCache } from "../board/board-route"

type Principal = { kind: "operator" } | { kind: "member"; user: { id: string; email: string; displayName: string }; boards: { department: string; role: BoardRole }[] }
let principal: Principal = { kind: "operator" }
vi.mock("@/routes/auth-provider", () => ({
  useAuthOptional: () => ({ principal, authState: { accountsEnabled: true, hasAccounts: true, principal } }),
}))
vi.mock("@/components/page-layout", () => ({ PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings: { employeeOverrides: {} } }) }))
vi.mock("@/hooks/use-gateway", () => ({ useGateway: () => ({ connectionSeq: 1, subscribe: () => () => {} }) }))
vi.mock("@/components/people/share-board-button", () => ({
  ShareBoardButton: ({ mode, ownRole }: { mode: string; ownRole?: string }) => <button data-testid="board-share">{mode}:{ownRole ?? ""}</button>,
}))

const createWorkItem = vi.fn()
const listWorkItems = vi.fn()
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      listWorkItems: (...args: unknown[]) => listWorkItems(...args),
      getWorkItemTree: async (id: string) => ({ tree: { root: { id, children: [], status: "backlog" }, totals: {}, spendUsd: 0 } }),
      getWorkItemTrees: async () => ({ trees: {} }),
      getWorkItems: async () => ({ workItems: [] }),
      getDepartments: async () => ({ departments: [{ slug: "platform", prefix: "PLT", createdAt: "", todoCount: 1 }] }),
      getOrg: async () => ({ departments: ["platform"], employees: [] }),
      createWorkItem: (...args: unknown[]) => createWorkItem(...args),
    },
  }
})

const card: WorkItemCompactWire = {
  id: "PLT-1", version: 2, title: "A person's Todo", status: "backlog", assignee: null, department: "platform", source: "connector", sourceRef: null,
  createdBy: "user:me", parentId: null, rootId: "PLT-1", depth: 0, dueAt: null, labels: [], blocked: false, updatedAt: "2026-07-23T08:00:00.000Z", rank: null,
} as WorkItemCompactWire

function memberOf(role: BoardRole): Principal {
  return { kind: "member", user: { id: "me", email: "me@example.test", displayName: "Mia Member" }, boards: [{ department: "platform", role }] }
}

function renderBoard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/todos/b/platform"]}>
        <Routes><Route path="/todos/b/:board" element={<TodoBoardPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  clearBoardScrollCache()
  sessionStorage.clear()
  localStorage.clear()
  listWorkItems.mockImplementation(async (params: { status?: string }) =>
    params.status === "backlog" ? { workItems: [card], total: 1, nextOffset: null } : { workItems: [], total: 0, nextOffset: null })
})

describe("the board for a member", () => {
  it("offers a viewer the cards and nothing to change", async () => {
    principal = memberOf("viewer")
    renderBoard()
    await screen.findByTestId("board-card-PLT-1")
    expect(screen.queryByTestId("todo-new")).toBeNull()
    expect(screen.queryByTestId("todo-quick-capture")).toBeNull()
    expect(screen.queryByTestId("board-share")).toBeNull()
    expect(screen.queryByTestId("department-board-menu")).toBeNull()
    expect(screen.queryByTestId("tree-add-subtask")).toBeNull()
    expect(screen.queryByTestId("keep-toggle-PLT-1")).toBeNull()
    // What a Todo has cost is the operator's to see.
    expect(screen.getByTestId("board-card-PLT-1").textContent).not.toMatch(/\$\d/)
    // The backlog column's own add affordance and the filter row are the operator's too.
    expect(screen.queryByTestId("board-quick-add-backlog")).toBeNull()
    expect(screen.queryByTestId("todos-filters")).toBeNull()
  })

  it("lets a collaborator file a Todo, unassigned, on the board they are looking at", async () => {
    principal = memberOf("collaborator")
    createWorkItem.mockResolvedValue({ workItem: { ...card, id: "PLT-2" } })
    renderBoard()
    await screen.findByTestId("board-card-PLT-1")
    expect(screen.queryByTestId("board-share")).toBeNull()
    fireEvent.click(screen.getByTestId("todo-new"))
    fireEvent.change(await screen.findByLabelText("Title"), { target: { value: "Ship the thing" } })
    fireEvent.click(screen.getByTestId("member-new-todo-create"))
    await waitFor(() => expect(createWorkItem).toHaveBeenCalledTimes(1))
    // No assignee, schedule or labels: the dialog does not ask, and nothing else rides along.
    expect(createWorkItem).toHaveBeenCalledWith({ title: "Ship the thing", department: "platform" })
  })

  it("gives a board owner Share, in member mode with their role", async () => {
    principal = memberOf("owner")
    renderBoard()
    await screen.findByTestId("board-card-PLT-1")
    expect(screen.getByTestId("board-share").textContent).toBe("member:owner")
  })

  it("leaves the operator's board exactly as it was: capture, add, move and archive all present", async () => {
    principal = { kind: "operator" }
    renderBoard()
    await screen.findByTestId("board-card-PLT-1")
    expect(screen.getByTestId("todo-new")).toBeTruthy()
    expect(screen.getByTestId("todo-quick-capture")).toBeTruthy()
    expect(screen.getByTestId("department-board-menu")).toBeTruthy()
    expect(screen.getByTestId("board-share").textContent).toBe("operator:")
    // The control the viewer test asserts absent is really there for the operator, so that absence is not a stale test id.
    expect(screen.getByTestId("todos-filters")).toBeTruthy()
    expect(screen.getByTestId("board-card-PLT-1").textContent).toMatch(/\$0\.00/)
    expect(screen.getByTestId("board-quick-add-backlog")).toBeTruthy()
  })
})
