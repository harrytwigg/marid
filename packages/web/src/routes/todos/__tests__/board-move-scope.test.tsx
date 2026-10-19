import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import "@/test/preload-menus"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkItemCompactWire, WorkItemListWire, WorkItemStatusWire } from "@/lib/api"
import TodoBoardPage from "../board/board-page"
import { clearBoardScrollCache } from "../board/board-route"

/* An optimistic status move belongs to the board it was made on. The switcher
 * changes the board in place — same route, a new param — so the board keeps its
 * state across the change, and a card moved on one board must never be drawn on
 * another, where its destination column will never hold it nor drop the entry. */

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

const EMPTY: WorkItemListWire = { workItems: [], total: 0, nextOffset: null }

/** What the switcher does: the same route, another board. */
function BoardSwitcher() {
  const navigate = useNavigate()
  return <button type="button" data-testid="switch-board" onClick={() => navigate("/todos/b/design")}>Design</button>
}

function renderBoard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/todos/b/platform"]}>
        <Routes>
          <Route path="/todos/b/:board" element={<><BoardSwitcher /><TodoBoardPage /></>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function setViewport(mobile: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: query === "(max-width: 700px)" ? mobile : false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}
const originalMatchMedia = window.matchMedia

/** A finger: the pointer sequence, then the click that follows it. */
function tap(element: Element) {
  fireEvent.pointerDown(element, { pointerType: "touch", button: 0, pointerId: 1 })
  fireEvent.pointerUp(element, { pointerType: "touch", button: 0, pointerId: 1 })
  fireEvent.click(element)
}

beforeEach(() => {
  vi.clearAllMocks()
  clearBoardScrollCache()
  sessionStorage.clear()
  localStorage.clear()
  rows = { executing: [compact("PLA-3", "executing")] }
  listWorkItems.mockImplementation((params: { status?: WorkItemStatusWire }) => Promise.resolve(listResponse(params)))
})

afterEach(() => {
  Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia })
})

describe("an optimistic move and the board that made it", () => {
  it("is not drawn on a board the card is not on", async () => {
    setViewport(true)
    const moving = compact("PLA-3", "executing")
    setWorkItemStatus.mockResolvedValue({ workItem: { ...moving, status: "in_review", version: 4 }, escalated: false })
    // Left in flight, like the write it follows.
    updateWorkItem.mockImplementation(() => new Promise(() => {}))
    renderBoard()
    await screen.findByTestId("board-card-PLA-3")

    /* The board's own refetches stay in flight, and the arriving board's are held and
     * then released: the move is still optimistic when the operator leaves, which is
     * when its entry can follow them, and the board they land on answers with nothing. */
    const arriving: Array<() => void> = []
    listWorkItems.mockImplementation((params: { status?: WorkItemStatusWire; department?: string }) => {
      if (params.department === "design") return new Promise((resolve) => arriving.push(() => resolve(EMPTY)))
      return new Promise(() => {})
    })

    tap(screen.getByTestId("board-move-PLA-3"))
    await screen.findByRole("menu")
    tap(screen.getByRole("menuitemradio", { name: "In review" }))
    await waitFor(() => expect(screen.getByTestId("board-column-in_review").contains(screen.getByTestId("board-card-PLA-3"))).toBe(true))

    fireEvent.click(screen.getByTestId("switch-board"))
    await act(async () => { arriving.splice(0).forEach((release) => release()) })
    // The board that arrives holds nothing: the move made on the board it left is not drawn here.
    await waitFor(() => expect(screen.getByTestId("board-column-in_review").querySelectorAll("[data-board-card]")).toHaveLength(0))
    expect(screen.queryByTestId("board-card-PLA-3")).toBeNull()
  })
})
