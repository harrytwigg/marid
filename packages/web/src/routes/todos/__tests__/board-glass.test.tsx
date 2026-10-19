import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen } from "@testing-library/react"
import { readFileSync } from "node:fs"
import path from "node:path"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkItemCompactWire, WorkItemListWire, WorkItemStatusWire } from "@/lib/api"
import TodoBoardPage from "../board/board-page"
import { clearBoardScrollCache } from "../board/board-route"

/* The glass board's hooks: what the stylesheet selects (columns, the Closed column and its
 * cards, headers, the board container) is marked in the DOM, and the stylesheet selects those
 * marks, not a role and a label that any control in a card could match. */

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

const IDENTITY = readFileSync(path.resolve(__dirname, "../../glass-identity.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")

function renderBoard(path = "/todos/b/platform") {
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

beforeEach(() => {
  vi.clearAllMocks()
  clearBoardScrollCache()
  sessionStorage.clear()
  rows = {
    backlog: [compact("PLA-1", "backlog")],
    executing: [compact("PLA-3", "executing")],
    done: [compact("PLA-8", "done")],
  }
  listWorkItems.mockImplementation((params: { status?: WorkItemStatusWire }) => Promise.resolve(listResponse(params)))
})

describe("the glass board's markup", () => {
  it("marks the board container, each column with its sticky header, and every card", async () => {
    renderBoard()
    await screen.findByTestId("board-card-PLA-3")

    const board = screen.getByTestId("todo-board-scroll")
    expect(board.hasAttribute("data-board-glass")).toBe(true)
    const executing = screen.getByTestId("board-column-executing")
    expect(executing.getAttribute("data-board-column")).toBe("executing")
    expect(executing.querySelector("[data-board-column-head]")).toBeTruthy()
    expect(executing.querySelector("[data-board-card]")).toBe(screen.getByTestId("board-card-PLA-3"))
  })

  it("gives the opened Closed column the same marks, so its cards take the card glass", async () => {
    renderBoard("/todos/b/platform?status=all")
    await screen.findByTestId("board-card-PLA-3")
    screen.getByTestId("board-closed-rail").click()

    const closed = await screen.findByTestId("board-closed-column")
    expect(closed.getAttribute("data-board-column")).toBe("closed")
    expect(closed.hasAttribute("data-board-snap")).toBe(true)
    expect(closed.querySelector("[data-board-column-head]")).toBe(screen.getByTestId("board-closed-collapse"))
    expect(closed.querySelector("[data-board-card]")).toBe(await screen.findByTestId("board-card-PLA-8"))
    expect(screen.getByTestId("todo-board-scroll").contains(closed)).toBe(true)
  })

  it("marks the Closed rail, which the phone's strip ends on, as a stop of the strip", async () => {
    renderBoard()
    await screen.findByTestId("board-card-PLA-3")
    const rail = screen.getByTestId("board-closed-rail")
    expect(rail.hasAttribute("data-board-rail")).toBe(true)
    expect(rail.hasAttribute("data-board-snap")).toBe(true)
  })
})

describe("the glass board's stylesheet", () => {
  it("styles cards by their mark, never by role and label", () => {
    expect(IDENTITY).toContain("[data-board-glass] [data-board-card]")
    expect(IDENTITY).not.toMatch(/\[role=["']button["']\]\[aria-label\]/)
  })

  it("drops the reading sheet only while the board is shown", () => {
    expect(IDENTITY).toContain('[data-shell="sheet"]:has([data-board-glass]:not([hidden]))')
  })

  it("blurs nothing on the board: columns, headers and cards are tints", () => {
    const start = IDENTITY.indexOf('[data-shell="sheet"]:has([data-board-glass]')
    const end = IDENTITY.indexOf(".glass-float, .glass-float-bar, .glass-tint, .glass-tint-bar {")
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    expect(IDENTITY.slice(start, end)).not.toMatch(/backdrop-filter/)
  })
})
