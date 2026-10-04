import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkItemCompactWire, WorkItemListWire, WorkItemStatusWire, WorkItemTreeWire } from "@/lib/api"
import TodoBoardPage from "../board/board-page"
import { isColumnInStatusFilter } from "../board/status-scope"
import { forgetBareEntries } from "@/lib/todo-filter-store"
import { clearBoardScrollCache } from "../board/board-route"

/* A board URL that names one status is a board of that one column. This is the
 * done-when of the Talk orb's open_todos: "executing todos I started" resolves
 * to /todos/b/everything?status=executing, and that link has to render what it says. */

vi.mock("@/components/page-layout", () => ({ PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings: { employeeOverrides: {} } }) }))
vi.mock("@/components/ui/employee-avatar", () => ({ EmployeeAvatar: () => <span /> }))
vi.mock("@/hooks/use-gateway", () => ({ useGateway: () => ({ connectionSeq: 1, subscribe: () => () => {} }) }))

const listWorkItems = vi.fn()
const setWorkItemKept = vi.fn()
const getWorkItemTrees = vi.fn()
const getDepartments = vi.fn()
const getOrg = vi.fn()

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      listWorkItems: (...args: unknown[]) => listWorkItems(...args),
      getWorkItemTrees: (...args: unknown[]) => getWorkItemTrees(...args),
      getWorkItem: vi.fn().mockRejectedValue(new Error("not found")),
      getWorkItems: vi.fn().mockResolvedValue({ workItems: [] }),
      getWorkItemTree: vi.fn(),
      getDepartments: (...args: unknown[]) => getDepartments(...args),
      getOrg: (...args: unknown[]) => getOrg(...args),
      setWorkItemStatus: vi.fn(),
      setWorkItemKept: (...args: unknown[]) => setWorkItemKept(...(args as [])),
      updateWorkItem: vi.fn(),
      createWorkItem: vi.fn(),
      assignWorkItem: vi.fn(),
    },
  }
})

function compact(id: string, status: WorkItemStatusWire): WorkItemCompactWire {
  return {
    id, status, version: 3, title: `Item ${id}`, assignee: null, department: "platform",
    source: "human", sourceRef: null,
    createdBy: "operator",
    parentId: null, rootId: id, depth: 0, dueAt: null, labels: [], blocked: false,
    updatedAt: "2026-07-23T08:00:00.000Z", rank: null,
  }
}

function tree(id: string): WorkItemTreeWire {
  return {
    root: {
      id, version: 3, title: `Item ${id}`, body: null, status: "executing", department: "platform",
      assignee: null, priority: 2, rank: null, source: "human", sourceRef: null,
      rounds: 0, budgetUsd: null,
      createdAt: "2026-07-23T08:00:00.000Z",
      updatedAt: "2026-07-23T08:00:00.000Z", closedAt: null, children: [],
    },
    totals: { executing: 1 },
    spendUsd: 0,
  }
}

/** One operator Todo per interesting status: backlog and executing tell an
 *  honestly-scoped board apart from one that just draws every column, and the
 *  closed pair tells it apart from one that treats "in scope" as "still open". */
const ROWS: Partial<Record<WorkItemStatusWire, WorkItemCompactWire[]>> = {
  backlog: [compact("PLA-1", "backlog")],
  executing: [compact("PLA-2", "executing")],
  done: [compact("PLA-3", "done")],
  cancelled: [compact("PLA-4", "cancelled")],
}

function listResponse(params: { status?: WorkItemStatusWire }): WorkItemListWire {
  const items = ROWS[params.status!] ?? []
  return { workItems: items, total: items.length, totals: { [params.status!]: items.length }, nextOffset: null }
}

beforeEach(() => {
  vi.clearAllMocks()
  clearBoardScrollCache()
  sessionStorage.clear()
  localStorage.clear()
  forgetBareEntries()
  listWorkItems.mockImplementation((params: { status?: WorkItemStatusWire }) => Promise.resolve(listResponse(params)))
  getWorkItemTrees.mockImplementation((ids: string[]) =>
    Promise.resolve({ trees: Object.fromEntries(ids.map((id) => [id, tree(id)])) }),
  )
  getDepartments.mockResolvedValue({ departments: [{ slug: "platform", prefix: "PLA", createdAt: "2026-07-01", todoCount: 2 }] })
  getOrg.mockResolvedValue({ departments: ["platform"], employees: [] })
  setWorkItemKept.mockResolvedValue({ kept: true })
})

function renderBoard(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/todos/b/:board" element={<TodoBoardPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/** The board picks its container from a media query rather than a width, so
 *  the phone layout is reachable in jsdom only by answering that query. */
function renderMobileBoard(path: string) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(max-width: 700px)",
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
  return renderBoard(path)
}

afterEach(() => vi.unstubAllGlobals())

describe("isColumnInStatusFilter", () => {
  it("keeps every column on the default open board, closed ones included", () => {
    for (const status of ["backlog", "executing", "done", "cancelled"] as const) {
      expect(isColumnInStatusFilter("open", status)).toBe(true)
      expect(isColumnInStatusFilter("all", status)).toBe(true)
    }
  })

  it("keeps only the named column when the URL names one status", () => {
    expect(isColumnInStatusFilter("executing", "executing")).toBe(true)
    for (const status of ["backlog", "in_review", "blocked", "done", "cancelled"] as const) {
      expect(isColumnInStatusFilter("executing", status)).toBe(false)
    }
  })
})

describe("/todos/b/everything?status=executing", () => {
  it("renders only the executing column, and only asks the gateway for it", async () => {
    renderBoard("/todos/b/everything?status=executing")

    await waitFor(() => expect(screen.getByTestId("board-column-executing")).toBeTruthy())
    expect(screen.getAllByText("Item PLA-2").length).toBeGreaterThan(0)
    // The backlog Todo exists and is in the board's scope; it is simply not
    // what the link asked for. Before this scoping it rendered anyway.
    expect(screen.queryAllByText("Item PLA-1")).toEqual([])
    expect(screen.queryByTestId("board-column-backlog")).toBeNull()

    const asked = listWorkItems.mock.calls.map(([params]) => params).filter((params) => params?.status)
    expect(asked.map((params) => params.status)).toEqual(["executing"])
    // Everything is roots only with no board-scope filter.
    expect(asked[0]).toMatchObject({ status: "executing", rootsOnly: true })
    expect(asked[0].home).toBeUndefined()
  })

  it("still draws the whole pipeline with no status in the URL", async () => {
    renderBoard("/todos/b/everything")

    await waitFor(() => expect(screen.getByTestId("board-column-backlog")).toBeTruthy())
    expect(screen.getByTestId("board-column-executing")).toBeTruthy()
    expect(screen.getAllByText("Item PLA-1").length).toBeGreaterThan(0)
    expect(screen.getAllByText("Item PLA-2").length).toBeGreaterThan(0)
  })
})

/* A closed status is a scope like any other. The board loaded the row all
 * along; it was the empty-state gate, counting only open columns, that told the
 * operator "No todos match." about a Todo sitting one element further down. */
describe("/todos/b/everything?status=done", () => {
  it("shows the done Todo in the list instead of the filtered-empty card", async () => {
    renderBoard("/todos/b/everything?status=done")

    const list = screen.getByTestId("todo-list-scroll")
    await waitFor(() => expect(within(list).getByTestId("todo-list-group-closed")).toBeTruthy())
    expect(within(list).getAllByText("Item PLA-3").length).toBeGreaterThan(0)
    expect(screen.queryByTestId("todo-list-filtered-empty")).toBeNull()
    expect(within(list).queryAllByText("Item PLA-1")).toEqual([])
  })

  it("arrives on the desktop board with the closed column already expanded", async () => {
    renderBoard("/todos/b/everything?status=done")

    const board = screen.getByTestId("todo-board-scroll")
    await waitFor(() => expect(within(board).getByTestId("board-closed-column")).toBeTruthy())
    expect(within(board).getAllByText("Item PLA-3").length).toBeGreaterThan(0)
    // Cancelled was never asked for, so it is absent rather than drawn as a zero.
    expect(within(board).queryByTestId("board-closed-group-cancelled")).toBeNull()
    expect(within(board).queryByTestId("board-closed-rail")).toBeNull()

    const asked = listWorkItems.mock.calls.map(([params]) => params).filter((params) => params?.status)
    expect(asked.map((params) => params.status)).toEqual(["done"])
  })

  it("arrives on the mobile Closed segment with the Todo visible, untapped", async () => {
    renderMobileBoard("/todos/b/everything?status=done")

    const board = screen.getByTestId("todo-board-scroll")
    await waitFor(() => expect(within(board).getAllByText("Item PLA-3").length).toBeGreaterThan(0))
  })

  it("shows the cancelled Todo the same way", async () => {
    renderBoard("/todos/b/everything?status=cancelled")

    const board = screen.getByTestId("todo-board-scroll")
    await waitFor(() => expect(within(board).getByTestId("board-closed-group-cancelled")).toBeTruthy())
    expect(within(board).getAllByText("Item PLA-4").length).toBeGreaterThan(0)
    expect(within(board).queryByTestId("board-closed-group-done")).toBeNull()
  })

  it("still offers the way back when the filter genuinely matches nothing", async () => {
    listWorkItems.mockImplementation(() =>
      Promise.resolve({ workItems: [], total: 0, totals: {}, nextOffset: null }),
    )
    renderBoard("/todos/b/everything?status=done&q=zzzz")

    await waitFor(() => expect(screen.getByTestId("todo-list-filtered-empty")).toBeTruthy())
  })

  /* The phone arrives on the Closed segment, so that segment rather than the
   * Active one is where a filter matching nothing has to offer the way back. It
   * read "Nothing closed yet.", which is a different and untrue claim. */
  it("offers the way back on the mobile Closed segment too", async () => {
    listWorkItems.mockImplementation(() =>
      Promise.resolve({ workItems: [], total: 0, totals: {}, nextOffset: null }),
    )
    renderMobileBoard("/todos/b/everything?status=done&q=zzzz")

    const board = screen.getByTestId("todo-board-scroll")
    await waitFor(() => expect(within(board).getByTestId("board-filtered-empty")).toBeTruthy())
    expect(within(board).queryByText("Nothing closed yet.")).toBeNull()
  })
})

/* A fresh instance has nothing on it. The unfiltered empty board is its own
 * quiet empty state — the columns and their quick-adds — not a crash, not a
 * "No todos match." card, and not a blank region where cards go. */
describe("/todos/b/everything with nothing on it", () => {
  beforeEach(() => listWorkItems.mockImplementation(() => Promise.resolve({ workItems: [], total: 0, totals: {}, nextOffset: null })))
  it("renders the empty board, not the filtered-empty card", async () => {
    renderBoard("/todos/b/everything")
    await waitFor(() => expect(screen.getByTestId("board-column-backlog")).toBeTruthy())
    expect(screen.queryByTestId("board-filtered-empty")).toBeNull()
    expect(document.querySelectorAll("[data-testid^=board-card-]").length).toBe(0)
  })
  it("reaches the phone", async () => {
    renderMobileBoard("/todos/b/everything")
    await waitFor(() => expect(screen.getByTestId("todo-board-scroll")).toBeTruthy())
    expect(screen.queryByTestId("todo-list-filtered-empty")).toBeNull()
  })
})

/* ICI-1357 round 2. The phone board draws TodoList rows, not cards, so the card's
 * keep control never reached 390px. The row carries its own now. */
describe("the phone board's keep control", () => {
  /** The desktop board stays mounted behind `hidden`, so a bare getByTestId
   *  matches its card too. The phone surface is the list scrollport. */
  const phoneRow = async (id: string) => {
    const list = await screen.findByTestId("todo-list-scroll")
    return within(list).getByTestId(`keep-toggle-${id}`)
  }

  it("gives every row a labelled keep button that survives without a pointer", async () => {
    renderMobileBoard("/todos/b/everything")
    await screen.findByTestId("todo-list-row-PLA-1")

    const button = await phoneRow("PLA-1")
    expect(button.tagName).toBe("BUTTON")
    expect(button.getAttribute("aria-label")).toBe("Keep PLA-1 on Home")
    expect(button.getAttribute("aria-pressed")).toBe("false")
    // Nothing hover-gated on a touch surface: no pointer will ever arrive.
    expect(button.className).not.toContain("opacity-0")
    expect(button.className).not.toContain("group-hover:")
    // A sibling of the row button, never nested inside it.
    expect(button.closest("[data-testid='todo-list-row-PLA-1']")).toBeNull()
  })

  it("keeps the Todo the row names", async () => {
    renderMobileBoard("/todos/b/everything")
    await screen.findByTestId("todo-list-row-PLA-1")

    fireEvent.click(await phoneRow("PLA-1"))
    await waitFor(() => expect(setWorkItemKept).toHaveBeenCalledWith("PLA-1", true))
  })

  /* Round-1 review: no onError anywhere, so a refused PUT said nothing. */
  it("says so when the gateway refuses, instead of looking like a dead click", async () => {
    setWorkItemKept.mockRejectedValue(new Error("boom"))
    renderMobileBoard("/todos/b/everything")
    await screen.findByTestId("todo-list-row-PLA-1")

    fireEvent.click(await phoneRow("PLA-1"))
    const callout = await screen.findByTestId("board-callout")
    expect(callout.textContent).toContain("refused")
  })
})
