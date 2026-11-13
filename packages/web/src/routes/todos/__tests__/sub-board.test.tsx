import "@/test/preload-dialogs"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkItemCompactWire, WorkItemStatusWire, WorkItemTreeNodeWire, WorkItemTreeWire } from "@/lib/api"
import type { BoardRole } from "@/lib/accounts-api"
import { BOARD_FILTERS_STORAGE_KEY } from "@/lib/todos"
import { TodoBoard } from "../board/board-page"
import { clearBoardScrollCache } from "../board/board-route"
import SubBoardDialog from "../board/sub-board-dialog"
import { SubBoardLocationProvider } from "../board/sub-board-location"

/* A Todo's sub-Todos as a board: the same board over the sub-board location, scoped to one Todo, its own header in
 * place of the title, none of the main board's chrome, and filters that stay in the pop-up. */

type Principal = { kind: "operator" } | { kind: "member"; user: { id: string; email: string; displayName: string }; boards: { department: string; role: BoardRole }[] }
let principal: Principal = { kind: "operator" }
vi.mock("@/routes/auth-provider", () => ({
  useAuthOptional: () => ({ principal, authState: { accountsEnabled: true, hasAccounts: true, principal } }),
}))
vi.mock("@/components/page-layout", () => ({ PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings: { employeeOverrides: {} } }) }))
vi.mock("@/hooks/use-gateway", () => ({ useGateway: () => ({ connectionSeq: 1, subscribe: () => () => {} }) }))

const listWorkItems = vi.fn()
const createWorkItem = vi.fn()
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      listWorkItems: (...args: unknown[]) => listWorkItems(...args),
      getWorkItemTrees: async (ids: string[]) => ({ trees: Object.fromEntries(ids.map((id) => [id, treeOf(id)])) }),
      getWorkItems: async () => ({ workItems: [] }),
      getDepartments: async () => ({ departments: [{ slug: "platform", prefix: "TSK", createdAt: "", todoCount: 4 }] }),
      getOrg: async () => ({ departments: ["platform"], employees: [{ name: "scout", displayName: "Scout", department: "platform", rank: "senior" }] }),
      createWorkItem: (...args: unknown[]) => createWorkItem(...args),
    },
  }
})

function compact(id: string, status: WorkItemStatusWire, parentId: string | null, title: string): WorkItemCompactWire {
  return {
    id, version: 2, title, status, assignee: null, department: "platform", source: "human", sourceRef: null,
    createdBy: "operator", parentId, rootId: "TSK-1", depth: parentId === "TSK-1" ? 1 : 2, dueAt: null, labels: [], blocked: false,
    updatedAt: "2026-07-23T08:00:00.000Z", rank: null,
  } as WorkItemCompactWire
}

const CHILD = compact("TSK-2", "backlog", "TSK-1", "Design the schema")
const SIBLING = compact("TSK-3", "executing", "TSK-1", "Write the migration")
const GRANDCHILD = compact("TSK-4", "backlog", "TSK-2", "Pick the column types")

/** TSK-1 → (TSK-2 → TSK-4), TSK-3: the tree every card and the header read. */
function node(item: WorkItemCompactWire, children: WorkItemTreeNodeWire[] = []): WorkItemTreeNodeWire {
  return { ...item, rank: null, body: null, priority: 2, rounds: 0, budgetUsd: null, createdAt: item.updatedAt, closedAt: null, children } as unknown as WorkItemTreeNodeWire
}
const ROOT = { ...compact("TSK-1", "executing", null, "Ship the importer"), rootId: "TSK-1", depth: 0 }
function treeOf(id: string): WorkItemTreeWire {
  if (id === "TSK-1") {
    return { root: node(ROOT, [node(CHILD, [node(GRANDCHILD)]), node(SIBLING)]), totals: { executing: 2, backlog: 2 }, spendUsd: 0 }
  }
  if (id === "TSK-2") return { root: node(CHILD, [node(GRANDCHILD)]), totals: { backlog: 2 }, spendUsd: 0 }
  const item = [CHILD, SIBLING, GRANDCHILD].find((candidate) => candidate.id === id) ?? ROOT
  return { root: node(item), totals: { [item.status]: 1 }, spendUsd: 0 }
}

const ALL = [CHILD, SIBLING, GRANDCHILD]
type ListParams = { status?: WorkItemStatusWire; parent?: string; descendantOf?: string }
function serve(params: ListParams) {
  const scoped = params.descendantOf ? ALL : params.parent ? ALL.filter((item) => item.parentId === params.parent) : []
  const items = scoped.filter((item) => item.status === params.status)
  return { workItems: items, total: items.length, totals: { [params.status!]: items.length }, nextOffset: null }
}

function Probe() {
  const location = useLocation()
  return <span data-testid="location" data-state={JSON.stringify(location.state ?? {})}>{location.pathname}</span>
}

const onClose = vi.fn()
function renderSubBoard(initialDepth: "children" | "all" = "children") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/page"]}>
        <Routes>
          <Route path="/page" element={<SubBoardLocationProvider rootId="TSK-1" initialDepth={initialDepth} onClose={onClose}><TodoBoard embedded /></SubBoardLocationProvider>} />
          <Route path="/todos/:todoId" element={<Probe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const statusCalls = () => listWorkItems.mock.calls.map(([params]) => params as Record<string, unknown>).filter((params) => params.status)

beforeEach(() => {
  principal = { kind: "operator" }
  vi.clearAllMocks()
  clearBoardScrollCache()
  sessionStorage.clear()
  localStorage.clear()
  listWorkItems.mockImplementation(async (params: ListParams) => serve(params))
})

describe("the sub-board's data", () => {
  it("reads the Todo's direct children by default, not roots, not a department", async () => {
    renderSubBoard()
    await screen.findByTestId("board-card-TSK-2")
    expect(screen.getByTestId("board-card-TSK-3")).toBeTruthy()
    expect(screen.queryByTestId("board-card-TSK-4")).toBeNull()
    for (const params of statusCalls()) {
      expect(params).toMatchObject({ parent: "TSK-1" })
      expect(params).not.toHaveProperty("descendantOf")
      expect(params.rootsOnly).toBeUndefined()
      expect(params.department).toBeUndefined()
    }
  })

  it("All levels reads every descendant, and names the parent of a card that hangs from a child", async () => {
    renderSubBoard("all")
    await screen.findByTestId("board-card-TSK-4")
    for (const params of statusCalls()) expect(params).toMatchObject({ descendantOf: "TSK-1" })
    // The chip names the parent from the root's tree: no fetch of its own.
    await waitFor(() => expect(screen.getByTestId("board-parent-TSK-4").textContent).toContain("Design the schema"))
    expect(screen.getByTestId("board-parent-TSK-4").textContent).toContain("TSK-2")
    // A direct child hangs from the board's root, which is the header: no chip.
    expect(screen.queryByTestId("board-parent-TSK-2")).toBeNull()
    expect(screen.queryByTestId("board-parent-TSK-3")).toBeNull()
  })

  it("keeps the roll-up as the way into a card's tray on Children", async () => {
    renderSubBoard()
    expect((await screen.findByTestId("board-rollup-TSK-2")).tagName).toBe("BUTTON")
  })

  it("flattens in All levels: the roll-up is a count, not a tray to open", async () => {
    renderSubBoard("all")
    const rollup = await screen.findByTestId("board-rollup-TSK-2")
    expect(rollup.tagName).toBe("SPAN")
    expect(rollup.textContent).toBe("0/1")
  })

  it("the depth toggle moves between the two scopes without leaving the pop-up", async () => {
    renderSubBoard()
    await screen.findByTestId("board-card-TSK-2")
    fireEvent.click(screen.getByTestId("sub-board-depth-all").querySelector("input")!)
    await screen.findByTestId("board-card-TSK-4")
    expect(screen.getByTestId("sub-board-depth-all").getAttribute("data-selected")).toBe("true")
    fireEvent.click(screen.getByTestId("sub-board-depth-children").querySelector("input")!)
    await waitFor(() => expect(screen.queryByTestId("board-card-TSK-4")).toBeNull())
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe("the sub-board's chrome", () => {
  it("opens as a wide dialog: its width is not capped by the base dialog's sm:max-w-lg", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/page"]}>
          <Routes>
            <Route path="/page" element={<SubBoardDialog rootId="TSK-1" onClose={onClose} />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    const box = await screen.findByTestId("sub-board-dialog")
    // A responsive max-width in the base classes outranks a bare max-w-none, so the wide dialog names its own at sm.
    expect(box.className).toContain("sm:max-w-none")
    expect(box.className).toContain("w-[min(1280px,calc(100vw-32px))]")
    await screen.findByTestId("board-card-TSK-2")
  })

  it("is headed by the root Todo, with no board switcher, quick capture or New Todo button", async () => {
    renderSubBoard()
    await screen.findByTestId("board-card-TSK-2")
    await waitFor(() => expect(screen.getByTestId("sub-board-root-title").textContent).toBe("Ship the importer"))
    expect(screen.getByTestId("sub-board-root-id").textContent).toBe("TSK-1")
    expect(screen.getByTestId("sub-board-rollup").textContent).toBe("0/3 done")
    expect(screen.queryByTestId("board-switcher")).toBeNull()
    expect(screen.queryByTestId("todo-quick-capture")).toBeNull()
    expect(screen.queryByTestId("todo-new")).toBeNull()
    expect(screen.queryByTestId("board-card-TSK-1")).toBeNull()
  })

  it("has no department filter, and a remembered main-board filter does not narrow it", async () => {
    localStorage.setItem(BOARD_FILTERS_STORAGE_KEY, "agent=scout&department=platform")
    renderSubBoard()
    await screen.findByTestId("board-card-TSK-2")
    for (const params of statusCalls()) {
      expect(params.assignee).toBeUndefined()
      expect(params.department).toBeUndefined()
    }
    expect(localStorage.getItem(BOARD_FILTERS_STORAGE_KEY)).toBe("agent=scout&department=platform")
  })

  it("opens the root Todo from the header, closing the pop-up first", async () => {
    renderSubBoard()
    await screen.findByTestId("board-card-TSK-2")
    fireEvent.click(screen.getByTestId("sub-board-open-root"))
    expect(onClose).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/todos/TSK-1"))
    expect(JSON.parse(screen.getByTestId("location").dataset.state!)).toEqual({ fromBoard: "sub:TSK-1:children" })
  })

  it("opens a card's Todo with the sub-board as where it came from", async () => {
    renderSubBoard("all")
    fireEvent.click(await screen.findByTestId("board-card-TSK-4"))
    expect(onClose).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/todos/TSK-4"))
    expect(JSON.parse(screen.getByTestId("location").dataset.state!)).toMatchObject({ fromBoard: "sub:TSK-1:all" })
  })

  it("adds a card from a column's + as a direct sub-Todo of the root", async () => {
    createWorkItem.mockResolvedValue({ workItem: { ...CHILD, id: "TSK-9" } })
    renderSubBoard("all")
    await screen.findByTestId("board-card-TSK-4")
    fireEvent.click(screen.getByTestId("board-quick-add-backlog"))
    fireEvent.change(await screen.findByTestId("todo-new-title"), { target: { value: "Back-fill the table" } })
    fireEvent.click(screen.getByTestId("todo-new-create"))
    await waitFor(() => expect(createWorkItem).toHaveBeenCalledTimes(1))
    // A child takes its department from its parent, so none is sent; it is born in the backlog like any new Todo.
    expect(createWorkItem.mock.calls[0][0]).toEqual({ title: "Back-fill the table", parentId: "TSK-1" })
  })
})

describe("the sub-board for a board member", () => {
  function memberOf(role: BoardRole): Principal {
    return { kind: "member", user: { id: "me", email: "me@example.test", displayName: "Mia Member" }, boards: [{ department: "platform", role }] }
  }

  it("reads it with the board's abilities: a viewer sees the cards and nothing to change", async () => {
    principal = memberOf("viewer")
    renderSubBoard()
    await screen.findByTestId("board-card-TSK-2")
    expect(screen.queryByTestId("board-quick-add-backlog")).toBeNull()
    expect(screen.queryByTestId("todos-filters")).toBeNull()
    expect(screen.queryByTestId("tree-add-subtask")).toBeNull()
  })

  it("lets a collaborator file a sub-Todo of the root through the member dialog", async () => {
    principal = memberOf("collaborator")
    createWorkItem.mockResolvedValue({ workItem: { ...CHILD, id: "TSK-9" } })
    renderSubBoard()
    await screen.findByTestId("board-card-TSK-2")
    await waitFor(() => expect(screen.getByTestId("board-quick-add-backlog")).toBeTruthy())
    fireEvent.click(screen.getByTestId("board-quick-add-backlog"))
    fireEvent.change(await screen.findByLabelText("Title"), { target: { value: "Back-fill the table" } })
    fireEvent.click(screen.getByTestId("member-new-todo-create"))
    await waitFor(() => expect(createWorkItem).toHaveBeenCalledTimes(1))
    expect(createWorkItem).toHaveBeenCalledWith({ title: "Back-fill the table", department: "platform", parentId: "TSK-1" })
  })
})
