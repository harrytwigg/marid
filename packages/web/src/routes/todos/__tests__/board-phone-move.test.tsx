import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import "@/test/preload-menus"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes, useLocation, useParams } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkItemCompactWire, WorkItemListWire, WorkItemStatusWire } from "@/lib/api"
import TodoBoardPage from "../board/board-page"
import { clearBoardScrollCache } from "../board/board-route"

/* The board on a phone: a card changes column from its "Move to…" menu, and a
 * long press does not lift it (the strip does not scroll itself under a held
 * card). Touch events throughout; the desktop keeps the drag and has no menu. */

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

function TaskProbe() {
  const { todoId } = useParams()
  const location = useLocation()
  return <div data-testid="task-probe" data-todo={todoId} data-state={JSON.stringify(location.state ?? {})} />
}

function renderBoard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/todos/b/platform"]}>
        <Routes>
          <Route path="/todos/b/:board" element={<TodoBoardPage />} />
          <Route path="/todos/:todoId" element={<TaskProbe />} />
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
  rows = {
    backlog: [compact("PLA-1", "backlog")],
    executing: [compact("PLA-3", "executing")],
    in_review: [compact("PLA-4", "in_review")],
  }
  listWorkItems.mockImplementation((params: { status?: WorkItemStatusWire }) => Promise.resolve(listResponse(params)))
})

afterEach(() => {
  Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia })
})

describe("moving a card on a phone", () => {
  it("moves it from the Move to… menu on a tap, lands it in the chosen column and says so", async () => {
    setViewport(true)
    setWorkItemStatus.mockResolvedValue({ workItem: { ...compact("PLA-3", "in_review"), version: 4 }, escalated: false })
    updateWorkItem.mockResolvedValue({ workItem: { ...compact("PLA-3", "in_review"), version: 5 } })
    renderBoard()
    await screen.findByTestId("board-card-PLA-3")

    tap(screen.getByTestId("board-move-PLA-3"))
    await screen.findByRole("menu")
    expect(screen.getByRole("menuitemradio", { name: "In progress" }).getAttribute("aria-checked")).toBe("true")
    tap(screen.getByRole("menuitemradio", { name: "In review" }))

    await waitFor(() => expect(setWorkItemStatus).toHaveBeenCalledWith("PLA-3", "in_review"))
    // Optimistic: the card is in In review at once, on top, and the callout names the move.
    const review = screen.getByTestId("board-column-in_review")
    await waitFor(() => expect(review.contains(screen.getByTestId("board-card-PLA-3"))).toBe(true))
    expect(screen.getByTestId("board-column-in_review").querySelectorAll("[data-board-card]")[0]?.getAttribute("data-board-card")).toBe("PLA-3")
    expect(screen.getByTestId("board-callout").textContent).toBe("PLA-3 moved to In review")
    // The tap was the menu's, not the card's: the task page did not open.
    expect(screen.queryByTestId("task-probe")).toBeNull()
  })

  it("a move into Blocked opens the task page on its reason field, as a drop does", async () => {
    setViewport(true)
    setWorkItemStatus.mockResolvedValue({ workItem: { ...compact("PLA-3", "blocked"), version: 4 }, escalated: false })
    updateWorkItem.mockResolvedValue({ workItem: { ...compact("PLA-3", "blocked"), version: 5 } })
    renderBoard()
    await screen.findByTestId("board-card-PLA-3")

    tap(screen.getByTestId("board-move-PLA-3"))
    await screen.findByRole("menu")
    tap(screen.getByRole("menuitemradio", { name: "Blocked" }))

    await waitFor(() => expect(setWorkItemStatus).toHaveBeenCalledWith("PLA-3", "blocked"))
    const probe = await screen.findByTestId("task-probe")
    expect(JSON.parse(probe.dataset.state!)).toMatchObject({ focusBannerReason: true, fromBoard: "platform" })
  })

  it("a refused move puts the card back and shows the gateway's words", async () => {
    setViewport(true)
    setWorkItemStatus.mockRejectedValue(new Error("The gateway refused the move"))
    renderBoard()
    await screen.findByTestId("board-card-PLA-3")

    tap(screen.getByTestId("board-move-PLA-3"))
    await screen.findByRole("menu")
    tap(screen.getByRole("menuitemradio", { name: "In review" }))

    await waitFor(() => expect(screen.getByTestId("board-callout").textContent).toContain("refused"))
    await waitFor(() => expect(screen.getByTestId("board-column-executing").contains(screen.getByTestId("board-card-PLA-3"))).toBe(true))
  })

  it("a long press does not lift the card: a held finger is a pan", async () => {
    setViewport(true)
    renderBoard()
    const card = await screen.findByTestId("board-card-PLA-3")

    fireEvent.pointerDown(card, { pointerType: "touch", button: 0, pointerId: 1, clientX: 40, clientY: 40 })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450))
    })
    expect(screen.queryByTestId("board-drag-slot")).toBeNull()
    expect(card.style.opacity).not.toBe("0")
    fireEvent.pointerUp(card, { pointerType: "touch", button: 0, pointerId: 1 })
    expect(setWorkItemStatus).not.toHaveBeenCalled()
  })

  it("the desktop has no Move to… on a card, and still lifts one", async () => {
    setViewport(false)
    renderBoard()
    const card = await screen.findByTestId("board-card-PLA-3")
    expect(screen.queryByTestId("board-move-PLA-3")).toBeNull()

    fireEvent.pointerDown(card, { button: 0, clientX: 210, clientY: 40, pointerType: "mouse" })
    await act(async () => {
      window.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, cancelable: true, clientX: 230, clientY: 60 }))
    })
    expect(screen.getByTestId("board-column-in_review")).toBeTruthy()
    await act(async () => {
      window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, cancelable: true, clientX: 230, clientY: 60 }))
    })
  })
})
