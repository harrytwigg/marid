/**
 * What an unrelated re-render costs on the two Todo surfaces.
 *
 * Both `TodoListRow` and `BoardCard` are memoised, so the cost of a state change
 * elsewhere on the page is decided entirely by prop identity. Each harness
 * reproduces the production shape — including the fresh arrow the list's quick-
 * add prop really is — and counts how many row bodies React executes.
 *
 * The counters are things each body reaches for exactly once and nothing else on
 * the surface reaches for: `formatRelativeTime` for a list row, and the 16px
 * status `StateCircle` for a board card. The board page mounts the list at every
 * width, so the board counter has to be something no list row can touch — see
 * the discriminator on the mock below. Both come from another module, so a
 * counting passthrough gives an exact body count.
 */
import { useRef, useState } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Employee, WorkItemCompactWire, WorkItemListWire, WorkItemStatusWire } from "@/lib/api"
import { installVirtualLayout, type VirtualLayout } from "@/test/virtual-layout"
import type { BoardColumnData } from "../board/use-board"
import { TodoList } from "../list/todo-list"
import TodoBoardPage from "../board/board-page"
import { clearBoardScrollCache } from "../board/board-route"

vi.mock("@/components/page-layout", () => ({ PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings: { employeeOverrides: {} } }) }))

const counters = vi.hoisted(() => ({ listRows: 0, boardCards: 0 }))

vi.mock("../util", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../util")>()
  return {
    ...actual,
    formatRelativeTime: (iso: string, now?: number) => {
      counters.listRows += 1
      return actual.formatRelativeTime(iso, now)
    },
  }
})

vi.mock("../state-glyph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state-glyph")>()
  const Actual = actual.StateCircle
  return {
    ...actual,
    StateCircle: (props: React.ComponentProps<typeof Actual>) => {
      // A board card's disc: 16px and a real status. Columns and the closed
      // rail draw 20px, the list group's own 16px disc carries the synthetic
      // `approval` key that `stateKeyOf` never returns, and the list row draws
      // a `StatusCircle`, whose inner disc is a self-reference this cannot see.
      if (props.size === 16 && props.keyOf !== "approval") counters.boardCards += 1
      return <Actual {...props} />
    },
  }
})

const listWorkItems = vi.fn()

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      listWorkItems: (...args: unknown[]) => listWorkItems(...args),
      getWorkItemTrees: vi.fn().mockResolvedValue({ trees: {} }),
      getWorkItems: vi.fn().mockResolvedValue({ workItems: [] }),
      getDepartments: vi.fn().mockResolvedValue({
        departments: [{ slug: "platform", prefix: "PLA", createdAt: "2026-07-01", todoCount: 2 }],
      }),
      getOrg: vi.fn().mockResolvedValue({ departments: ["platform"], employees: [] }),
      createWorkItem: vi.fn(),
      assignWorkItem: vi.fn(),
      setWorkItemStatus: vi.fn(),
      updateWorkItem: vi.fn(),
      decideWorkItemApproval: vi.fn(),
      escalateWorkItemApproval: vi.fn(),
    },
  }
})

const LIST_COUNT = 500
const BOARD_COUNT = 30
const ROW_H = 44
const VIEWPORT_H = 800
/** Window + overscan on both sides, generously rounded. Nowhere near 500. */
const WINDOW_CEILING = 40
const NOW = Date.parse("2026-08-01T09:00:00.000Z")

const ALL_STATUSES: WorkItemStatusWire[] = [
  "backlog", "executing", "in_review", "blocked", "done", "cancelled",
]

function compact(id: string, status: WorkItemStatusWire, rank: number): WorkItemCompactWire {
  return {
    id,
    version: 1,
    title: `Item ${id}`,
    status,
    assignee: null,
    department: "platform",
    source: "human",
    sourceRef: null,
    approvalState: null,
    approvalRequest: null,
    approvalRef: null,
    approvalTarget: null,
    approvalEscalatedAt: null,
    createdBy: "operator",
    parentId: null,
    rootId: id,
    depth: 0,
    dueAt: null,
    labels: [],
    blocked: false,
    updatedAt: "2026-07-31T08:00:00.000Z",
    rank,
  }
}

const LIST_ITEMS = Array.from({ length: LIST_COUNT }, (_, i) => compact(`PLA-${i}`, "backlog", i))
const BOARD_ITEMS = Array.from({ length: BOARD_COUNT }, (_, i) => compact(`PLA-${i}`, "backlog", i))

/** Stable identities, as react-query hands them to the page. */
const COLUMNS = Object.fromEntries(ALL_STATUSES.map((status) => [status, {
  status,
  items: status === "backlog" ? LIST_ITEMS : [],
  total: status === "backlog" ? LIST_COUNT : 0,
  hasMore: false,
  loadMore: () => {},
  loadingMore: false,
}])) as Record<WorkItemStatusWire, BoardColumnData>
const NO_ATTENTION: WorkItemCompactWire[] = []
const BY_NAME = new Map<string, Employee>()
const OPEN_ROW = () => {}

/** Mirrors board-page.tsx: `onQuickAdd` is a new arrow on every render. */
function ListHarness() {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [tick, setTick] = useState(0)
  return (
    <div ref={scrollRef} data-testid="todo-list-scroll">
      <button type="button" data-testid="unrelated-state" onClick={() => setTick((n) => n + 1)}>{tick}</button>
      <TodoList
        columns={COLUMNS}
        needsAttention={NO_ATTENTION}
        byName={BY_NAME}
        trees={undefined}
        now={NOW}
        onOpen={OPEN_ROW}
        onQuickAdd={() => {}}
        scrollRef={scrollRef}
      />
    </div>
  )
}

function boardResponse(params: { status?: WorkItemStatusWire; needsAttentionFor?: string }): WorkItemListWire {
  if (params.needsAttentionFor) return { workItems: [], total: 0, nextOffset: null }
  const items = params.status === "backlog" ? BOARD_ITEMS : []
  return { workItems: items, total: items.length, nextOffset: null, totals: { [params.status!]: items.length } }
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

let layout: VirtualLayout | null = null

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  sessionStorage.clear()
  clearBoardScrollCache()
  counters.listRows = 0
  counters.boardCards = 0
  listWorkItems.mockImplementation((params: { status?: WorkItemStatusWire; needsAttentionFor?: string }) =>
    Promise.resolve(boardResponse(params)),
  )
})

afterEach(() => {
  layout?.release()
  layout = null
})

describe("Todo surface render cost", () => {
  it("mounts a window of list rows, not the whole list", () => {
    layout = installVirtualLayout(ROW_H, VIEWPORT_H, {
      scroller: '[data-testid="todo-list-scroll"]',
      row: '[data-testid^="todo-list-row-"]',
      rowId: "data-testid",
    })
    const { unmount } = render(<ListHarness />)

    const mounted = layout.mountedRowIds().length
    console.log(`[todo render cost] listItems=${LIST_COUNT} mountedRows=${mounted}`
      + ` mountRowRenders=${counters.listRows}`)
    expect(mounted).toBeGreaterThan(0)
    expect(mounted).toBeLessThan(WINDOW_CEILING)
    // Mounting cost follows the window, not the data.
    expect(counters.listRows).toBeLessThan(WINDOW_CEILING)
    unmount()
  })

  it("leaves the list rows alone when unrelated page state changes", () => {
    layout = installVirtualLayout(ROW_H, VIEWPORT_H, {
      scroller: '[data-testid="todo-list-scroll"]',
      row: '[data-testid^="todo-list-row-"]',
      rowId: "data-testid",
    })
    const { unmount } = render(<ListHarness />)
    expect(layout.mountedRowIds().length).toBeGreaterThan(0)

    counters.listRows = 0
    fireEvent.click(screen.getByTestId("unrelated-state"))
    const rowRenders = counters.listRows
    unmount()

    console.log(`[todo render cost] unrelatedStateRowRenders=${rowRenders}`)
    // Rows are memoised on facts about themselves. Any render here means a prop
    // identity changed, which on a long list is the whole window re-rendering
    // every time a filter, a poll or a dialog touches the page.
    expect(rowRenders).toBe(0)
  })

  it("leaves the board cards alone when unrelated page state changes", async () => {
    const { unmount } = renderBoard()
    await screen.findByTestId("board-card-PLA-0")
    const cards = document.querySelectorAll("[data-board-card]").length
    expect(cards).toBe(BOARD_COUNT)
    // A counter the card body stopped calling would make the assertion below
    // pass forever without measuring anything, so prove it counts first.
    expect(counters.boardCards).toBeGreaterThanOrEqual(BOARD_COUNT)

    counters.boardCards = 0
    // Opening the new-Todo dialog is page state that touches no card's data.
    fireEvent.click(screen.getByTestId("todo-new"))
    const cardRenders = counters.boardCards
    unmount()

    console.log(`[todo render cost] boardCards=${cards} unrelatedStateCardRenders=${cardRenders}`)
    expect(cardRenders).toBe(0)
  })
})
