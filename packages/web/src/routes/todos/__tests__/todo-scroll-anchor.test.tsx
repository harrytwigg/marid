import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkItemCompactWire, WorkItemListWire, WorkItemStatusWire, WorkItemTreeWire } from "@/lib/api"
import { installVirtualLayout } from "@/test/virtual-layout"
import TodoBoardPage from "../board/board-page"
import { clearBoardScrollCache } from "../board/board-route"

/**
 * Scroll anchoring on the Todos list.
 *
 * jsdom has no layout engine, so the list is given one: every anchored row is
 * ROW_H tall, the scrollport is VIEWPORT_H tall, and a row's rect follows its
 * position in the CURRENT DOM order minus scrollTop. That makes "where is this
 * row on screen" a number the test can read before and after a status change,
 * which is the thing the reader actually notices.
 */

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
      getWorkItemTree: vi.fn().mockRejectedValue(new Error("not used")),
      getWorkItem: vi.fn().mockRejectedValue(new Error("not used")),
      getWorkItems: vi.fn().mockResolvedValue({ workItems: [] }),
      getDepartments: vi.fn().mockResolvedValue({ departments: [{ slug: "platform", prefix: "PLA", createdAt: "2026-07-01", todoCount: 3 }] }),
      getOrg: vi.fn().mockResolvedValue({ departments: ["platform"], employees: [] }),
      setWorkItemStatus: vi.fn(),
      updateWorkItem: vi.fn(),
      createWorkItem: vi.fn(),
      assignWorkItem: vi.fn(),
    },
  }
})

const ROW_H = 60
const VIEWPORT_H = 600

function compact(id: string, status: WorkItemStatusWire, rank: number): WorkItemCompactWire {
  return {
    id, status, rank,
    version: 3,
    title: `Item ${id}`,
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
  }
}

let rows: Partial<Record<WorkItemStatusWire, WorkItemCompactWire[]>> = {}

function listResponse(status: WorkItemStatusWire): WorkItemListWire {
  const workItems = rows[status] ?? []
  return { workItems, total: workItems.length, totals: { [status]: workItems.length }, nextOffset: null }
}

function renderBoard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/todos/b/platform"]}>
        <Routes>
          <Route path="/todos/b/:board" element={<TodoBoardPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { ...view, client }
}

interface Layout {
  scroller: HTMLDivElement
  rowIds: () => string[]
  /** Distance from the scrollport's top edge to this row's top edge. */
  offsetOf: (id: string) => number
  scrollTo: (top: number) => void
}

function installLayout(testId: string, rowAttribute = "data-anchor-id"): Layout {
  const scroller = screen.getByTestId(testId) as HTMLDivElement
  const rowIds = () =>
    Array.from(scroller.querySelectorAll<HTMLElement>(`[${rowAttribute}]`))
      .map((row) => row.getAttribute(rowAttribute) as string)
  const scrollHeight = () => rowIds().length * ROW_H
  let scrollTop = 0

  Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => VIEWPORT_H })
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => scrollHeight() })
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    // Browsers clamp; without this a restore could park the list past its end.
    set: (next: number) => { scrollTop = Math.max(0, Math.min(next, Math.max(0, scrollHeight() - VIEWPORT_H))) },
  })

  const offsetOf = (id: string) => rowIds().indexOf(id) * ROW_H - scrollTop
  const rect = (top: number, height: number) => ({
    top, bottom: top + height, height, left: 0, right: 390, width: 390, x: 0, y: top, toJSON: () => ({}),
  })
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this === scroller) return rect(0, VIEWPORT_H) as DOMRect
    const id = this.getAttribute(rowAttribute)
    if (!id || !scroller.contains(this) || rowIds().indexOf(id) < 0) return rect(0, 0) as DOMRect
    return rect(offsetOf(id), ROW_H) as DOMRect
  })

  return {
    scroller,
    rowIds,
    offsetOf,
    scrollTo: (top: number) => act(() => { scroller.scrollTop = top; fireEvent.scroll(scroller) }),
  }
}

/** What a status write leaves behind: `["work-items"]` invalidated, every
 *  column refetched, the list re-grouped. See todo-status-mutation's onSettled. */
async function settleStatusChange(client: QueryClient) {
  await act(async () => { await client.invalidateQueries({ queryKey: ["work-items"] }) })
}

beforeEach(() => {
  vi.clearAllMocks()
  clearBoardScrollCache()
  localStorage.clear()
  sessionStorage.clear()
  rows = {}
  listWorkItems.mockImplementation((params: { status?: WorkItemStatusWire; needsAttentionFor?: string }) =>
    Promise.resolve(params.needsAttentionFor
      ? { workItems: [], total: 0, nextOffset: null }
      : listResponse(params.status!)),
  )
  getWorkItemTrees.mockResolvedValue({ trees: {} as Record<string, WorkItemTreeWire> })
})

afterEach(() => { vi.restoreAllMocks() })

describe("Todos list scroll anchoring", () => {
  it("holds the read position when a status change moves a row into a group above it", async () => {
    rows.backlog = Array.from({ length: 40 }, (_, k) => compact(`PLA-${k + 1}`, "backlog", k))
    const { client } = renderBoard()
    await screen.findByTestId("todo-list-row-PLA-1")

    const layout = installLayout("todo-list-scroll")
    layout.scrollTo(8.5 * ROW_H)
    const anchored = layout.rowIds()[8]
    const before = layout.offsetOf(anchored)
    expect(anchored).toBe("PLA-9")
    expect(before).toBe(-30)

    // PLA-30 sits below the reader and moves backlog → executing. Executing is
    // grouped above Backlog, so the row lands above the read position and every
    // row under it — including the anchored one — is pushed down.
    const moved = { ...rows.backlog[29], status: "executing" as const }
    rows.backlog = rows.backlog.filter((item) => item.id !== moved.id)
    rows.executing = [moved]
    await settleStatusChange(client)

    expect(layout.rowIds()[0]).toBe("PLA-30")
    expect(layout.rowIds().indexOf(anchored)).toBe(9)
    expect(Math.abs(layout.offsetOf(anchored) - before)).toBeLessThanOrEqual(2)
    expect(layout.scroller.scrollTop).toBe(8.5 * ROW_H + ROW_H)
  })

  it("holds it when the group above the reader grows", async () => {
    rows.backlog = Array.from({ length: 40 }, (_, k) => compact(`PLA-${k + 1}`, "backlog", k))
    const { client } = renderBoard()
    await screen.findByTestId("todo-list-row-PLA-1")

    const layout = installLayout("todo-list-scroll")
    layout.scrollTo(12.5 * ROW_H)
    const anchored = layout.rowIds()[12]
    const before = layout.offsetOf(anchored)

    rows.executing = [compact("PLA-90", "executing", 0), compact("PLA-91", "executing", 1)]
    await settleStatusChange(client)

    expect(layout.rowIds().indexOf(anchored)).toBe(14)
    expect(Math.abs(layout.offsetOf(anchored) - before)).toBeLessThanOrEqual(2)
    expect(layout.scroller.scrollTop).toBe(12.5 * ROW_H + 2 * ROW_H)
  })

  it("leaves a reader at the top of the list at the top", async () => {
    rows.backlog = Array.from({ length: 40 }, (_, k) => compact(`PLA-${k + 1}`, "backlog", k))
    const { client } = renderBoard()
    await screen.findByTestId("todo-list-row-PLA-1")

    const layout = installLayout("todo-list-scroll")
    rows.executing = [compact("PLA-90", "executing", 0)]
    await settleStatusChange(client)

    expect(layout.rowIds()[0]).toBe("PLA-90")
    expect(layout.scroller.scrollTop).toBe(0)
  })
})

/**
 * The same reflow above `VIRTUALIZE_THRESHOLD`, where the list is windowed and
 * the anchor corrects a scrollport whose rows mount and unmount underneath it.
 * Forty Todos keeps every case above this one below the threshold, on the
 * un-windowed harness at the top of the file; this one brings its own.
 */
describe("Todos list scroll anchoring, windowed", () => {
  /** The virtualizer's own item estimate, so an unmeasured row is this tall. */
  const WINDOW_ROW_H = 44

  // The guard for the windowed list reading the page's own scroller: unwire
  // `getScrollElement` in list/list-window.tsx and no row mounts, so this fails.
  it("holds the read position when the group above the reader grows", async () => {
    rows.backlog = Array.from({ length: 80 }, (_, k) => compact(`PLA-${k + 1}`, "backlog", k))
    const layout = installVirtualLayout(WINDOW_ROW_H, VIEWPORT_H, {
      scroller: '[data-testid="todo-list-scroll"]', row: "[data-anchor-id]", rowId: "data-anchor-id",
    })
    const { client } = renderBoard()
    await screen.findByTestId("todo-list-row-PLA-1")

    const read = 30.5 * WINDOW_ROW_H
    layout.scrollTo(read)
    await vi.waitFor(() => expect(layout.scrollTop()).toBe(read))
    const anchored = layout.visibleRowIds()[0]
    const before = layout.offsetOf(anchored)

    rows.executing = [compact("PLA-90", "executing", 0), compact("PLA-91", "executing", 1)]
    await settleStatusChange(client)
    // The refetch's render lands after the invalidate resolves, and the
    // correction rides with it: holding the place is what moves the scrollport.
    await vi.waitFor(() => expect(layout.scrollTop()).toBeGreaterThan(read))

    // `offsetOf` throws on an unmounted row, so this also proves the window
    // still covers where the reader was left.
    expect(Math.abs(layout.offsetOf(anchored) - before)).toBeLessThanOrEqual(2)
  })
})

describe("Todos board scroll anchoring", () => {
  it("holds the read position when cards land above the reader", async () => {
    rows.backlog = Array.from({ length: 40 }, (_, k) => compact(`PLA-${k + 1}`, "backlog", k))
    const { client } = renderBoard()
    await screen.findByTestId("board-card-PLA-1")

    const layout = installLayout("todo-board-scroll", "data-board-card")
    layout.scrollTo(8.5 * ROW_H)
    const anchored = layout.rowIds()[8]
    const before = layout.offsetOf(anchored)
    expect(before).toBe(-30)
    // Backlog is the board's first column, so cards land above the reader by
    // ranking ahead of them rather than by moving into an earlier group.
    rows.backlog = [compact("PLA-90", "backlog", -2), compact("PLA-91", "backlog", -1), ...rows.backlog!]
    await settleStatusChange(client)

    expect(layout.rowIds().indexOf(anchored)).toBe(10)
    expect(Math.abs(layout.offsetOf(anchored) - before)).toBeLessThanOrEqual(2)
    expect(layout.scroller.scrollTop).toBe(8.5 * ROW_H + 2 * ROW_H)
  })

  it("follows the content when the anchored card leaves the board, without snapping to an edge", async () => {
    rows.backlog = Array.from({ length: 40 }, (_, k) => compact(`PLA-${k + 1}`, "backlog", k))
    const { client } = renderBoard()
    await screen.findByTestId("board-card-PLA-1")

    const layout = installLayout("todo-board-scroll", "data-board-card")
    layout.scrollTo(8.5 * ROW_H)
    const anchored = layout.rowIds()[8]

    // Closing the anchored card drops it out of the board's active columns, so
    // the restore has no row left to measure and falls back to the height delta.
    rows.backlog = rows.backlog!.filter((item) => item.id !== anchored)
    await settleStatusChange(client)

    expect(layout.rowIds()).not.toContain(anchored)
    expect(layout.scroller.scrollTop).toBe(8.5 * ROW_H - ROW_H)
    expect(layout.scroller.scrollTop).toBeGreaterThan(0)
    expect(layout.scroller.scrollTop).toBeLessThan(layout.scroller.scrollHeight - VIEWPORT_H)
  })
})
