import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes, useLocation, type InitialEntry } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkItemFullWire, WorkItemTreeNodeWire } from "@/lib/api"
import { TodoOpenContext, type OpenTodo } from "@/components/chat/file-open-context"
import { FileLinkSessionContext } from "@/components/chat/file-link-session-context"
import TaskPage, { TaskView } from "../task-page/task-page"

/* The one Todo view, in both places it is shown: as a tab of the chat layout,
 * where it is the whole Todo without the app shell around it and the Todos it
 * links to open as tabs beside it; and at its route, where a phone's back
 * chevron returns to the mention that opened it. */

vi.mock("@/components/page-layout", () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div data-testid="page-layout">{children}</div>,
}))
vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings: { employeeOverrides: {} } }) }))
vi.mock("@/routes/providers", () => ({ useTheme: () => ({ theme: "dark" }) }))

const getWorkItem = vi.fn()
const getWorkItemTree = vi.fn()

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      getWorkItem: (...args: unknown[]) => getWorkItem(...args),
      getWorkItemTree: (...args: unknown[]) => getWorkItemTree(...args),
      listWorkItemAttachments: vi.fn().mockResolvedValue({ attachments: [] }),
      listWorkItemComments: vi.fn().mockResolvedValue({ comments: [], total: 0 }),
      listWorkItemSessions: vi.fn().mockResolvedValue([]),
      getDepartments: vi.fn().mockResolvedValue({ departments: [] }),
      getOrg: vi.fn().mockResolvedValue({ departments: [], employees: [], hierarchy: { root: null, sorted: [], warnings: [] } }),
      listWorkItems: vi.fn().mockResolvedValue({ workItems: [], total: 0, nextOffset: null }),
    },
  }
})

function full(id: string, overrides: Partial<WorkItemFullWire> = {}): WorkItemFullWire {
  return {
    id, version: 3, title: `Item ${id}`, body: null, status: "executing", department: "platform",
    assignee: null, priority: 2, rank: null, source: "human", sourceRef: null, rounds: 1, budgetUsd: null,
    createdBy: "operator", parentId: null, rootId: id, depth: 0, dueAt: null,
    createdAt: "2026-07-20T08:00:00.000Z", updatedAt: "2026-07-23T08:00:00.000Z", closedAt: null,
    ...overrides,
  }
}

const node = (item: WorkItemFullWire, children: WorkItemTreeNodeWire[] = []): WorkItemTreeNodeWire => ({ ...item, children })

function Location() {
  return <span data-testid="path">{useLocation().pathname}</span>
}

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
}

function renderTab(openTodo: OpenTodo | null) {
  return render(
    <QueryClientProvider client={client()}>
      <MemoryRouter initialEntries={["/chat"]}>
        <TodoOpenContext.Provider value={openTodo}>
          <FileLinkSessionContext.Provider value="chat-a">
            <TaskView todoId="PLA-12" embedded />
          </FileLinkSessionContext.Provider>
        </TodoOpenContext.Provider>
        <Location />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function renderRoute(entries: InitialEntry[]) {
  return render(
    <QueryClientProvider client={client()}>
      <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
        <Routes>
          <Route path="/todos/:todoId" element={<TaskPage />} />
          <Route path="/todos/b/:board" element={<div data-testid="board-probe" />} />
          <Route path="*" element={<div data-testid="chat-probe" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/** The page's one mobile breakpoint is 700px; jsdom has no matchMedia of its own. */
function stubViewport(mobile: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: mobile && query === "(max-width: 700px)",
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia
}

beforeEach(() => {
  vi.clearAllMocks()
  stubViewport(false)
  getWorkItem.mockImplementation((id: string) => Promise.resolve({ workItem: full(id), spendUsd: 0, events: [] }))
  getWorkItemTree.mockResolvedValue({
    tree: { root: node(full("PLA-12"), [node(full("PLA-13", { parentId: "PLA-12", rootId: "PLA-12", depth: 1 }))]), totals: {}, spendUsd: 0 },
  })
})

afterEach(() => {
  delete (window as { matchMedia?: unknown }).matchMedia
})

describe("a Todo opened as a tab", () => {
  it("is the whole Todo, inside the tab rather than the app shell", async () => {
    renderTab(null)

    expect((await screen.findByTestId("task-title")).textContent).toBe("Item PLA-12")
    expect(screen.getByTestId("todo-tab-view")).toBeTruthy()
    expect(screen.queryByTestId("page-layout")).toBeNull()
    for (const testId of ["task-crumb-bar", "task-chip-cluster", "task-body", "task-props-rail", "task-composer"]) {
      expect(screen.getByTestId(testId), testId).toBeTruthy()
    }
    expect(await screen.findByTestId("task-subtasks")).toBeTruthy()
  })

  it("opens a sub-task as a tab beside the chat, leaving the chat where it was", async () => {
    const openTodo = vi.fn<OpenTodo>(() => true)
    renderTab(openTodo)

    fireEvent.click(await screen.findByTestId("subtask-open-PLA-13"))

    expect(openTodo).toHaveBeenCalledWith("PLA-13", "chat-a")
    expect(screen.getByTestId("path").textContent).toBe("/chat")
  })

  it("follows a sub-task to its page when the layout cannot take a tab", async () => {
    const openTodo = vi.fn<OpenTodo>(() => false)
    renderTab(openTodo)

    fireEvent.click(await screen.findByTestId("subtask-open-PLA-13"))

    expect(openTodo).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId("path").textContent).toBe("/todos/PLA-13")
  })
})

describe("the Todo page's back affordance", () => {
  const fromMention = [{ pathname: "/" }, { pathname: "/todos/PLA-12", state: { returnBack: true } }]

  it("returns a phone to the mention that opened the Todo", async () => {
    stubViewport(true)
    renderRoute(fromMention)

    fireEvent.click(await screen.findByTestId("task-crumb-back"))

    expect(await screen.findByTestId("chat-probe")).toBeTruthy()
  })

  it("still goes to the board from a phone that arrived any other way", async () => {
    stubViewport(true)
    renderRoute(["/", "/todos/PLA-12"])

    fireEvent.click(await screen.findByTestId("task-crumb-back"))

    expect(await screen.findByTestId("board-probe")).toBeTruthy()
  })

  it("keeps the desktop crumb going to the board it names", async () => {
    renderRoute(fromMention)

    fireEvent.click(await screen.findByTestId("task-crumb-board"))

    expect(await screen.findByTestId("board-probe")).toBeTruthy()
  })
})
