import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TodoOpenContext, type OpenTodo } from "@/components/chat/file-open-context"
import type { WorkItemCompactWire, WorkItemListWire, WorkItemStatusWire, WorkItemTreeWire } from "@/lib/api"
import { BOARD_FILTERS_STORAGE_KEY } from "@/lib/todos"
import { clearBoardScrollCache } from "../board/board-route"
import TodosTabView from "../board/todos-tab-view"
import { clearTodosTabLocationMemory, seedTodosTabLocation, TODOS_TAB_LOCATION_KEY } from "../board/todos-tab-location"

/* The Todos board as a chat layout tab: its board and filters live in the tab's own stored
 * location, never in the router, and a card opens as a Todo tab where the layout can take one. */

vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings: { employeeOverrides: {} } }) }))

const listWorkItems = vi.fn()
const getWorkItemTrees = vi.fn()

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      listWorkItems: (...args: unknown[]) => listWorkItems(...args),
      getWorkItemTrees: (...args: unknown[]) => getWorkItemTrees(...args),
      getWorkItems: vi.fn().mockResolvedValue({ workItems: [] }),
      getDepartments: vi.fn().mockResolvedValue({
        departments: [{ slug: "platform", prefix: "TSK", createdAt: "2026-07-01", todoCount: 2 }],
      }),
      getOrg: vi.fn().mockResolvedValue({
        departments: ["platform"],
        employees: [{ name: "builder", displayName: "Builder", department: "platform", rank: "senior" }],
      }),
      createWorkItem: vi.fn(),
      assignWorkItem: vi.fn(),
      setWorkItemStatus: vi.fn(),
      updateWorkItem: vi.fn(),
    },
  }
})

function compact(id: string, status: WorkItemStatusWire): WorkItemCompactWire {
  return {
    id, version: 1, title: `Item ${id}`, status, assignee: "builder", department: "platform", source: "human",
    sourceRef: null, createdBy: "operator", parentId: null, rootId: id, depth: 0, dueAt: null, labels: [],
    blocked: status === "blocked", updatedAt: "2026-07-31T08:00:00.000Z", rank: null,
  }
}

function tree(item: WorkItemCompactWire): WorkItemTreeWire {
  return {
    root: { ...item, rank: item.rank ?? null, body: null, priority: 2, rounds: 0, budgetUsd: null, createdAt: item.updatedAt, closedAt: null, children: [] },
    totals: { [item.status]: 1 },
    spendUsd: 0,
  }
}

let rows: Partial<Record<WorkItemStatusWire, WorkItemCompactWire[]>> = {}

function response(params: { status?: WorkItemStatusWire; needsAttentionFor?: string }): WorkItemListWire {
  if (params.needsAttentionFor) return { workItems: [], total: 0, nextOffset: null }
  const items = rows[params.status!] ?? []
  return { workItems: items, total: items.length, nextOffset: null, totals: { [params.status!]: items.length } }
}

function LocationProbe() {
  const location = useLocation()
  return <span data-testid="location-probe">{location.pathname + location.search}</span>
}

function renderTab(opener: OpenTodo | null = null, onPaneClick = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/chat"]}>
        <TodoOpenContext.Provider value={opener}>
          <Routes>
            <Route path="/chat" element={<div onClick={onPaneClick}><TodosTabView /><LocationProbe /></div>} />
            <Route path="/todos/:todoId" element={<LocationProbe />} />
          </Routes>
        </TodoOpenContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const stored = () => JSON.parse(localStorage.getItem(TODOS_TAB_LOCATION_KEY) ?? "null")
/** What the board last asked a column for: the calls that name a status, not the inbox's. */
const lastParams = () =>
  listWorkItems.mock.calls.map((call) => call[0] as Record<string, unknown>).filter((params) => params.status).at(-1)!

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  sessionStorage.clear()
  clearBoardScrollCache()
  clearTodosTabLocationMemory()
  rows = {}
  listWorkItems.mockImplementation((params: { status?: WorkItemStatusWire; needsAttentionFor?: string }) =>
    Promise.resolve(response(params)),
  )
  getWorkItemTrees.mockImplementation((ids: string[]) => {
    const items = Object.values(rows).flat().filter((item): item is WorkItemCompactWire => !!item)
    return Promise.resolve({ trees: Object.fromEntries(ids.map((id) => [id, tree(items.find((item) => item.id === id)!)])) })
  })
})

const originalMatchMedia = window.matchMedia
function setViewport(mobile: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: query === "(max-width: 700px)" ? mobile : false,
      media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }),
  })
}
afterEach(() => {
  vi.restoreAllMocks()
  Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia })
})

async function switchTo(boardTestId: string) {
  const trigger = await screen.findByTestId("board-switcher")
  fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" })
  fireEvent.click(trigger)
  fireEvent.click(await screen.findByTestId(boardTestId))
}

describe("the Todos tab's board location", () => {
  it("opens on Everything with the stored filters when nothing was stored for the tab", async () => {
    localStorage.setItem(BOARD_FILTERS_STORAGE_KEY, "assignee=builder")
    rows.backlog = [compact("TSK-1", "backlog")]
    renderTab()

    await screen.findByTestId("board-card-TSK-1")
    expect(screen.getByTestId("board-switcher").textContent).toContain("Everything")
    expect(lastParams().assignee).toBe("builder")
    expect(screen.getByTestId("location-probe").textContent).toBe("/chat")
  })

  it("renders the stored board and filters", async () => {
    localStorage.setItem(TODOS_TAB_LOCATION_KEY, JSON.stringify({ version: 1, board: "platform", search: "assignee=builder" }))
    rows.backlog = [compact("TSK-1", "backlog")]
    renderTab()

    await screen.findByTestId("board-card-TSK-1")
    expect(screen.getByTestId("board-switcher").textContent).toContain("Platform")
    expect(lastParams()).toMatchObject({ department: "platform", assignee: "builder" })
  })

  it("falls back to the default for a record it cannot read", async () => {
    for (const raw of ["not json", JSON.stringify({ version: 2, board: "platform", search: "" })]) {
      localStorage.setItem(TODOS_TAB_LOCATION_KEY, raw)
      const view = renderTab()
      expect((await screen.findByTestId("board-switcher")).textContent).toContain("Everything")
      view.unmount()
    }
  })

  it("switches boards and changes filters in its own state and storage, never the router", async () => {
    localStorage.setItem(TODOS_TAB_LOCATION_KEY, JSON.stringify({ version: 1, board: "platform", search: "q=widget" }))
    renderTab()
    const chip = await screen.findByRole("button", { name: 'Remove Matching "widget"' })

    fireEvent.click(chip)
    await waitFor(() => expect(stored()).toEqual({ version: 1, board: "platform", search: "" }))
    expect(screen.queryByRole("button", { name: 'Remove Matching "widget"' })).toBeNull()

    await switchTo("board-menu-everything")
    await waitFor(() => expect(screen.getByTestId("board-switcher").textContent).toContain("Everything"))
    expect(stored().board).toBe("everything")
    expect(screen.getByTestId("location-probe").textContent).toBe("/chat")
  })

  it("starts where a seed said to, and follows a seed written while it is on screen", async () => {
    seedTodosTabLocation({ kind: "department", slug: "platform" }, "?assignee=builder")
    expect(stored()).toEqual({ version: 1, board: "platform", search: "assignee=builder" })
    renderTab()
    await waitFor(() => expect(screen.getByTestId("board-switcher").textContent).toContain("Platform"))
    expect(lastParams().assignee).toBe("builder")

    act(() => seedTodosTabLocation({ kind: "attention" }, ""))
    await waitFor(() => expect(screen.getByTestId("board-switcher").textContent).toContain("Attention"))
  })

  it("keeps the location for the page's life when storage is unusable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked") })
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked") })
    renderTab()

    await switchTo("board-menu-attention")
    await waitFor(() => expect(screen.getByTestId("board-switcher").textContent).toContain("Attention"))
  })
})

describe("a card in the Todos tab", () => {
  it("opens as a Todo tab where the layout can take one, and the pane does not take the click", async () => {
    rows.backlog = [compact("TSK-1", "backlog")]
    const opener = vi.fn(() => true)
    const onPaneClick = vi.fn()
    renderTab(opener, onPaneClick)

    fireEvent.click(await screen.findByTestId("board-card-TSK-1"))

    expect(opener).toHaveBeenCalledWith("TSK-1", null)
    expect(onPaneClick).not.toHaveBeenCalled()
    expect(screen.getByTestId("location-probe").textContent).toBe("/chat")
  })

  it("lets the pane have a click that opened nothing", async () => {
    rows.backlog = [compact("TSK-1", "backlog")]
    const onPaneClick = vi.fn()
    renderTab(() => false, onPaneClick)

    fireEvent.click(await screen.findByTestId("board-switcher"))
    expect(onPaneClick).toHaveBeenCalled()
  })

  it("goes to the Todo's page where the layout declines it", async () => {
    rows.backlog = [compact("TSK-1", "backlog")]
    const opener = vi.fn(() => false)
    renderTab(opener)

    fireEvent.click(await screen.findByTestId("board-card-TSK-1"))

    await waitFor(() => expect(screen.getByTestId("location-probe").textContent).toBe("/todos/TSK-1"))
    expect(opener).toHaveBeenCalledWith("TSK-1", null)
  })

  it("goes to the page with no layout around it at all", async () => {
    rows.backlog = [compact("TSK-1", "backlog")]
    renderTab(null)

    fireEvent.click(await screen.findByTestId("board-card-TSK-1"))
    await waitFor(() => expect(screen.getByTestId("location-probe").textContent).toBe("/todos/TSK-1"))
  })
})

describe("the Todos tab on a phone", () => {
  it("renders the phone board inside the tab, with no app chrome", async () => {
    setViewport(true)
    rows.executing = [compact("TSK-1", "executing")]
    renderTab()

    await screen.findByTestId("board-card-TSK-1")
    expect(screen.getByRole("radiogroup", { name: "Board layout" })).toBeTruthy()
    expect(screen.getByTestId("todo-mobile-filters")).toBeTruthy()
    expect(screen.getByTestId("todos-tab-view").contains(screen.getByTestId("todo-board-scroll"))).toBe(true)
    expect(document.querySelector("[data-shell]")).toBeNull()
  })
})
