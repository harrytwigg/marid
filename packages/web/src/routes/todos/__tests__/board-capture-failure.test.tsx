import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkItemCompactWire, WorkItemListWire, WorkItemStatusWire } from "@/lib/api"
import { clearNoticeSink, registerNoticeSink } from "@/lib/notices"
import TodoBoardPage from "../board/board-page"
import { clearBoardScrollCache } from "../board/board-route"

/* The quick-capture bar is a separate chunk. When it cannot be fetched, pressing the button takes
 * the loading scrim down again and says so, instead of leaving the page dimmed. */

vi.mock("../quick-add/capture-bar", () => {
  throw new Error("Failed to fetch dynamically imported module")
})
vi.mock("@/components/page-layout", () => ({ PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings: { employeeOverrides: {} } }) }))

const listWorkItems = vi.fn()
const setWorkItemStatus = vi.fn()
const updateWorkItem = vi.fn()

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      listWorkItems: (...args: unknown[]) => listWorkItems(...args),
      setWorkItemStatus: (...args: unknown[]) => setWorkItemStatus(...args),
      updateWorkItem: (...args: unknown[]) => updateWorkItem(...args),
      getWorkItemTree: vi.fn().mockRejectedValue(new Error("no tree")),
      getWorkItemTrees: vi.fn().mockResolvedValue({ trees: {} }),
      getWorkItem: vi.fn().mockRejectedValue(Object.assign(new Error("nf"), { status: 404 })),
      getWorkItems: vi.fn().mockResolvedValue({ workItems: [] }),
      getDepartments: vi.fn().mockResolvedValue({ departments: [] }),
      getOrg: vi.fn().mockResolvedValue({ departments: [], employees: [] }),
      createWorkItem: vi.fn(),
      assignWorkItem: vi.fn(),
    },
  }
})

function compact(id: string, status: WorkItemStatusWire): WorkItemCompactWire {
  return {
    id,
    version: 3,
    title: `Item ${id}`,
    status,
    assignee: null,
    department: "platform",
    source: "human",
    sourceRef: null,
    createdBy: "operator",
    parentId: null,
    rootId: id,
    depth: 0,
    dueAt: null,
    labels: [],
    blocked: false,
    updatedAt: "2026-07-23T08:00:00.000Z",
    rank: null,
  }
}

let rows: Partial<Record<WorkItemStatusWire, WorkItemCompactWire[]>> = {}

function listResponse(params: { status?: WorkItemStatusWire }): WorkItemListWire {
  const items = rows[params.status!] ?? []
  return { workItems: items, total: items.length, nextOffset: null }
}

function renderBoard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/todos/b/platform"]}>
        <Routes>
          <Route path="/todos/b/:board" element={<TodoBoardPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  clearNoticeSink()
  clearBoardScrollCache()
  sessionStorage.clear()
  rows = { executing: [compact("PLA-3", "executing")] }
  listWorkItems.mockImplementation((params: { status?: WorkItemStatusWire }) => Promise.resolve(listResponse(params)))
})

describe("the quick-capture bar's chunk failing to load", () => {
  it("takes the scrim down and says so on the notice surface, so the page is not left dimmed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const notice = vi.fn()
    registerNoticeSink(notice)
    renderBoard()
    await screen.findByTestId("board-card-PLA-3")

    fireEvent.click(screen.getByTestId("todo-quick-capture"))

    await waitFor(() => expect(notice).toHaveBeenCalledWith({ title: "Quick capture couldn't load. Reload the page and try again.", level: "error" }))
    expect(screen.queryByTestId("quick-capture-loading")).toBeNull()
    expect(screen.queryByTestId("quick-capture")).toBeNull()
  })
})
