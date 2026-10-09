import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { MemoryRouter, Route, Routes, useLocation, type InitialEntry } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkItemFullWire, WorkItemTreeNodeWire } from "@/lib/api"
import { TodoOpenContext, type OpenTodo } from "@/components/chat/file-open-context"
import { FileLinkSessionContext } from "@/components/chat/file-link-session-context"
import { AREAS } from "@/contrib/types"
import { contributeProbes } from "@/contrib/__tests__/hosted-area"
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

function renderTab(openTodo: OpenTodo | null, ids: string[] = ["PLA-12"]) {
  return render(
    <QueryClientProvider client={client()}>
      <MemoryRouter initialEntries={["/chat"]}>
        <TodoOpenContext.Provider value={openTodo}>
          <FileLinkSessionContext.Provider value="chat-a">
            {ids.map((id) => <div key={id} data-testid={`pane-${id}`}><TaskView todoId={id} embedded /></div>)}
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

describe("two Todos open side by side", () => {
  it("returns focus to the row in the view whose picker closed, not the other one", async () => {
    renderTab(null, ["PLA-12", "PLA-13"])
    const second = within(screen.getByTestId("pane-PLA-13"))
    await within(screen.getByTestId("pane-PLA-12")).findByTestId("rail-status")
    const row = await second.findByTestId("rail-status")

    fireEvent.click(row)
    fireEvent.keyDown(await second.findByTestId("picker-status"), { key: "Escape" })

    await waitFor(() => expect(second.queryByTestId("picker-status")).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(row))
  })
})

describe("what a tab leaves to the page", () => {
  it("renders no page-scoped plugin contributions, which read their Todo from the URL", async () => {
    const dispose = [
      contributeProbes(AREAS.todoDetailActions, [{ id: "action" }]),
      contributeProbes(AREAS.todoDetailSections, [{ id: "section" }]),
    ]
    try {
      const page = renderRoute(["/todos/PLA-12"])
      await screen.findByTestId("task-title")
      expect(screen.getByTestId("probe-action")).toBeTruthy()
      expect(screen.getByTestId("probe-section")).toBeTruthy()
      page.unmount()

      renderTab(null)
      await screen.findByTestId("task-title")
      expect(screen.queryByTestId("probe-action")).toBeNull()
      expect(screen.queryByTestId("probe-section")).toBeNull()
    } finally {
      for (const disposer of dispose) disposer()
    }
  })

  it("offers no way out to the Todos page for a deleted Todo, since that would leave the chat", async () => {
    getWorkItem.mockRejectedValue(Object.assign(new Error("not found"), { status: 404 }))
    renderTab(null)

    expect(await screen.findByText("PLA-12 doesn't exist (anymore).")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Back to Todos" })).toBeNull()
    expect(screen.getByTestId("path").textContent).toBe("/chat")
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
