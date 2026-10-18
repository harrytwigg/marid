import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkItemCompactWire, WorkItemListWire, WorkItemStatusWire, WorkItemTreeWire } from "@/lib/api"
import TodoBoardPage from "../board/board-page"
import { clearBoardScrollCache } from "../board/board-route"

vi.mock("@/components/page-layout", () => ({ PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
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
        departments: [{ slug: "platform", prefix: "PLA", createdAt: "2026-07-01", todoCount: 2 }],
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
    id,
    version: 1,
    title: `Item ${id}`,
    status,
    assignee: "builder",
    department: "platform",
    source: "human",
    sourceRef: null,
    createdBy: "operator",
    parentId: null,
    rootId: id,
    depth: 0,
    dueAt: null,
    labels: [],
    blocked: status === "blocked",
    updatedAt: "2026-07-31T08:00:00.000Z",
    rank: null,
  }
}

function tree(item: WorkItemCompactWire): WorkItemTreeWire {
  return {
    root: {
      ...item,
      rank: item.rank ?? null,
      body: null,
      priority: 2,

      rounds: 0,
      budgetUsd: null,
      createdAt: item.updatedAt,
      closedAt: null,
      children: [],
    },
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
  return <span data-testid="location-probe">{location.pathname}</span>
}

function DetailProbe() {
  const navigate = useNavigate()
  return <button type="button" data-testid="detail-back" onClick={() => navigate(-1)}>Back</button>
}

function renderTodos(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/todos/b/:board" element={<><TodoBoardPage /><LocationProbe /></>} />
          <Route path="/todos/:todoId" element={<DetailProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  sessionStorage.clear()
  clearBoardScrollCache()
  rows = {}
  listWorkItems.mockImplementation((params: { status?: WorkItemStatusWire; needsAttentionFor?: string }) =>
    Promise.resolve(response(params)),
  )
  getWorkItemTrees.mockImplementation((ids: string[]) => {
    const items = Object.values(rows).flat().filter((item): item is WorkItemCompactWire => !!item)
    return Promise.resolve({
      trees: Object.fromEntries(ids.map((id) => {
        const found = items.find((item) => item.id === id)!
        return [id, tree(found)]
      })),
    })
  })
})

/** jsdom has no matchMedia; the board's ONE breakpoint is 700px, and the page
 *  reads the view off it. Leaving it unstubbed IS the SSR/no-window case. */
const originalMatchMedia = window.matchMedia
let breakpointListener: ((event: MediaQueryListEvent) => void) | undefined
function setViewport(mobile: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: query === "(max-width: 700px)" ? mobile : false,
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        breakpointListener = listener
      },
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}

afterEach(() => {
  breakpointListener = undefined
  Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia })
})

describe("the Todos board on a phone", () => {
  it("shows the board on a phone viewport, one column a screen, with a Board | List switch on Board", async () => {
    setViewport(true)
    rows.executing = [compact("PLA-1", "executing")]
    renderTodos("/todos/b/platform")

    await screen.findByTestId("board-card-PLA-1")
    expect((screen.getByTestId("todo-board-scroll") as HTMLDivElement).hidden).toBe(false)
    expect((screen.getByTestId("todo-list-scroll") as HTMLDivElement).hidden).toBe(true)
    expect(screen.getByRole("radiogroup", { name: "Board layout" })).toBeTruthy()
    expect((screen.getByRole("radio", { name: "Board" }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole("radio", { name: "List" }) as HTMLInputElement).checked).toBe(false)
    // The columns are what the strip snaps to: To do, In progress, In review, and the Closed rail.
    const snaps = document.querySelectorAll("[data-board-snap]")
    expect(snaps).toHaveLength(4)
    expect(screen.getByTestId("board-column-position").getAttribute("aria-label")).toBe("Column 1 of 4")
  })

  it("shows the grouped list on a phone when List is chosen, keeps Closed collapsed, and remembers the choice", async () => {
    setViewport(true)
    rows.executing = [compact("PLA-1", "executing")]
    rows.done = [compact("PLA-2", "done")]
    const first = renderTodos("/todos/b/platform")

    await screen.findByTestId("board-card-PLA-1")
    fireEvent.click(screen.getByRole("radio", { name: "List" }))

    await screen.findByTestId("todo-list-row-PLA-1")
    expect((screen.getByTestId("todo-list-scroll") as HTMLDivElement).hidden).toBe(false)
    expect((screen.getByTestId("todo-board-scroll") as HTMLDivElement).hidden).toBe(true)
    expect(screen.queryByTestId("board-column-position")).toBeNull()
    expect(screen.queryByTestId("todo-list-group-needs-you")).toBeNull()
    expect(screen.getByTestId("todo-list-group-executing")).toBeTruthy()
    expect(screen.getByTestId("todo-list-group-in-review")).toBeTruthy()
    expect(screen.getByTestId("todo-list-group-backlog")).toBeTruthy()
    expect(screen.getByTestId("todo-list-group-closed")).toBeTruthy()
    expect(screen.queryByTestId("todo-list-row-PLA-2")).toBeNull()
    expect(localStorage.getItem("jinn-board-phone-view")).toBe("list")

    // A new visit on the same device opens on the list.
    first.unmount()
    renderTodos("/todos/b/platform")
    await screen.findByTestId("todo-list-row-PLA-1")
    expect((screen.getByRole("radio", { name: "List" }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByTestId("todo-board-scroll") as HTMLDivElement).hidden).toBe(true)
  })

  it("returns from a card to the column the strip was on, not the first", async () => {
    setViewport(true)
    rows.executing = [compact("PLA-1", "executing")]
    renderTodos("/todos/b/platform")
    const card = await screen.findByTestId("board-card-PLA-1")
    const strip = screen.getByTestId("todo-board-scroll") as HTMLDivElement

    strip.scrollLeft = 679
    fireEvent.scroll(strip)
    fireEvent.click(card)
    await screen.findByTestId("detail-back")
    fireEvent.click(screen.getByTestId("detail-back"))

    await waitFor(() => expect((screen.getByTestId("todo-board-scroll") as HTMLDivElement).scrollLeft).toBe(679))
  })

  it("moves between Board and List with the arrow keys, as a native radio group does", async () => {
    setViewport(true)
    rows.executing = [compact("PLA-1", "executing")]
    renderTodos("/todos/b/platform")
    await screen.findByTestId("board-card-PLA-1")

    const user = userEvent.setup()
    screen.getByRole("radio", { name: "Board" }).focus()
    await user.keyboard("{ArrowRight}")

    expect((screen.getByRole("radio", { name: "List" }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByTestId("todo-list-scroll") as HTMLDivElement).hidden).toBe(false)
    await user.keyboard("{ArrowLeft}")
    expect((screen.getByRole("radio", { name: "Board" }) as HTMLInputElement).checked).toBe(true)
  })

  it("opens on the board when the device's storage cannot be read or written", async () => {
    setViewport(true)
    rows.executing = [compact("PLA-1", "executing")]
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    renderTodos("/todos/b/platform")

    await screen.findByTestId("board-card-PLA-1")
    expect((screen.getByRole("radio", { name: "Board" }) as HTMLInputElement).checked).toBe(true)
    fireEvent.click(screen.getByRole("radio", { name: "List" }))
    await screen.findByTestId("todo-list-row-PLA-1")
    vi.restoreAllMocks()
  })

  it("offers no switch on a desktop viewport", async () => {
    setViewport(false)
    rows.executing = [compact("PLA-1", "executing")]
    renderTodos("/todos/b/platform")

    await screen.findByTestId("board-card-PLA-1")
    expect(screen.queryByRole("radiogroup", { name: "Board layout" })).toBeNull()
    expect(screen.queryByTestId("board-column-position")).toBeNull()
  })

  it("flips to the phone layout live when the viewport crosses the breakpoint, without a remount", async () => {
    setViewport(false)
    rows.executing = [compact("PLA-1", "executing")]
    renderTodos("/todos/b/platform")

    const board = await screen.findByTestId("todo-board-scroll")
    expect((board as HTMLDivElement).hidden).toBe(false)
    expect(screen.queryByRole("radiogroup", { name: "Board layout" })).toBeNull()

    act(() => breakpointListener?.({ matches: true } as MediaQueryListEvent))

    // The phone opens on the board too: the switch arrives, and nothing else moves.
    await screen.findByRole("radiogroup", { name: "Board layout" })
    expect((screen.getByTestId("todo-board-scroll") as HTMLDivElement).hidden).toBe(false)
    expect((screen.getByTestId("todo-list-scroll") as HTMLDivElement).hidden).toBe(true)
    fireEvent.click(screen.getByRole("radio", { name: "List" }))
    await waitFor(() => expect((screen.getByTestId("todo-list-scroll") as HTMLDivElement).hidden).toBe(false))
    expect((screen.getByTestId("todo-board-scroll") as HTMLDivElement).hidden).toBe(true)
    // Same node either side of the flip: the page re-rendered, it did not remount.
    expect(screen.getByTestId("todo-board-scroll")).toBe(board)
    expect(screen.getByTestId("location-probe").textContent).toBe("/todos/b/platform")
  })
})
