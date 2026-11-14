import "@/test/preload-dialogs"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { createMemoryRouter, RouterProvider, useLocation, type RouteObject } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkItemCompactWire, WorkItemStatusWire, WorkItemTreeNodeWire, WorkItemTreeWire } from "@/lib/api"
import { TodoBoardTabContext } from "@/components/chat/file-open-context"
import { BOARD_FILTERS_STORAGE_KEY } from "@/lib/todos"
import { clearBoardScrollCache } from "../board/board-route"
import SubBoardDialog from "../board/sub-board-dialog"
import SubBoardTabView from "../board/sub-board-tab-view"
import { clearSubBoardTabState, readSubBoardTabState, writeSubBoardTabState } from "../board/sub-board-tab-state"
import { useSubBoardView } from "../task-page/use-sub-board-view"

/* A Todo's sub-board as a pinned tab, and as a pop-up at the Todo's route: the stored variant of the sub-board
 * location, the tab's calm "not available" state, the pop-up's Pin as tab, and the `?view=board` address. */

let principal: { kind: "operator" } | { kind: "member"; user: { id: string; email: string; displayName: string }; boards: { department: string; role: "viewer" | "collaborator" | "owner" }[] } = { kind: "operator" }
vi.mock("@/routes/auth-provider", () => ({
  useAuthOptional: () => ({ principal, authState: { accountsEnabled: true, hasAccounts: true, principal } }),
}))
vi.mock("@/components/page-layout", () => ({ PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings: { employeeOverrides: {} } }) }))
vi.mock("@/hooks/use-gateway", () => ({ useGateway: () => ({ connectionSeq: 1, subscribe: () => () => {} }) }))

const listWorkItems = vi.fn()
let rootMissing = false
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      listWorkItems: (...args: unknown[]) => listWorkItems(...args),
      getWorkItemTrees: async (ids: string[]) => ({ trees: Object.fromEntries(ids.filter(() => !rootMissing).map((id) => [id, treeOf(id)])) }),
      getWorkItems: async () => ({ workItems: [] }),
      getDepartments: async () => ({ departments: [{ slug: "platform", prefix: "TSK", createdAt: "", todoCount: 4 }] }),
      getOrg: async () => ({ departments: ["platform"], employees: [] }),
    },
  }
})

function compact(id: string, status: WorkItemStatusWire, parentId: string | null, title: string): WorkItemCompactWire {
  return {
    id, version: 2, title, status, assignee: null, department: "platform", source: "human", sourceRef: null,
    createdBy: "operator", parentId, rootId: "TSK-1", depth: parentId === "TSK-1" ? 1 : 2, dueAt: null, labels: [], blocked: false,
    updatedAt: "2026-07-23T08:00:00.000Z", rank: null,
  } as WorkItemCompactWire
}
const CHILD = compact("TSK-2", "backlog", "TSK-1", "Design the schema")
const SIBLING = compact("TSK-3", "executing", "TSK-1", "Write the migration")
const GRANDCHILD = compact("TSK-4", "backlog", "TSK-2", "Pick the column types")
const ROOT = { ...compact("TSK-1", "executing", null, "Ship the importer"), rootId: "TSK-1", depth: 0 }
function node(item: WorkItemCompactWire, children: WorkItemTreeNodeWire[] = []): WorkItemTreeNodeWire {
  return { ...item, rank: null, body: null, priority: 2, rounds: 0, budgetUsd: null, createdAt: item.updatedAt, closedAt: null, children } as unknown as WorkItemTreeNodeWire
}
function treeOf(id: string): WorkItemTreeWire {
  const root = id === "TSK-1" ? node(ROOT, [node(CHILD, [node(GRANDCHILD)]), node(SIBLING)]) : node([CHILD, SIBLING, GRANDCHILD].find((item) => item.id === id) ?? ROOT)
  return { root, totals: { executing: 1 }, spendUsd: 0 }
}
const ALL = [CHILD, SIBLING, GRANDCHILD]
type ListParams = { status?: WorkItemStatusWire; parent?: string; descendantOf?: string; q?: string }
function serve(params: ListParams) {
  const scoped = params.descendantOf ? ALL : params.parent ? ALL.filter((item) => item.parentId === params.parent) : []
  const items = scoped.filter((item) => item.status === params.status)
  return { workItems: items, total: items.length, totals: { [params.status!]: items.length }, nextOffset: null }
}

function Where() {
  const location = useLocation()
  return <><span data-testid="where">{location.pathname}{location.search}</span><span data-testid="state">{JSON.stringify(location.state)}</span></>
}

type Entry = string | { pathname: string; search?: string; state?: unknown }
function mount(entry: Entry | Entry[], routes: RouteObject[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const entries = Array.isArray(entry) ? entry : [entry]
  const router = createMemoryRouter(routes, { initialEntries: entries, initialIndex: entries.length - 1 })
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return router
}

const where = () => screen.getByTestId("where").textContent
const stateOf = () => JSON.parse(screen.getByTestId("state").textContent || "null")
const tabRoutes = (todoId = "TSK-1"): RouteObject[] => [
  { path: "/", element: <><SubBoardTabView todoId={todoId} /><Where /></> },
  { path: "/todos/:todoId", element: <Where /> },
]

function phone(matches: boolean) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: matches ? 390 : 1280 })
  window.matchMedia = ((query: string) => ({
    matches: matches && query.includes("max-width: 700px"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
    onchange: null,
  })) as unknown as typeof window.matchMedia
}

beforeEach(() => {
  principal = { kind: "operator" }
  rootMissing = false
  vi.clearAllMocks()
  clearBoardScrollCache()
  sessionStorage.clear()
  localStorage.clear()
  clearSubBoardTabState("TSK-1")
  phone(false)
  listWorkItems.mockImplementation(async (params: ListParams) => serve(params))
})

describe("the pinned sub-board tab", () => {
  it("opens on the children, headed by its root, with no Pin as tab (it is the tab)", async () => {
    mount("/", tabRoutes())
    await screen.findByTestId("board-card-TSK-2")
    expect(screen.queryByTestId("board-card-TSK-4")).toBeNull()
    await waitFor(() => expect(screen.getByTestId("sub-board-root-title").textContent).toBe("Ship the importer"))
    expect(screen.queryByTestId("sub-board-pin")).toBeNull()
  })

  it("keeps its depth in its own stored record, and comes back at that depth", async () => {
    const first = mount("/", tabRoutes())
    await screen.findByTestId("board-card-TSK-2")
    fireEvent.click(screen.getByTestId("sub-board-depth-all").querySelector("input")!)
    await screen.findByTestId("board-card-TSK-4")
    expect(readSubBoardTabState("TSK-1").depth).toBe("all")
    expect(JSON.parse(localStorage.getItem("hundredfold-sub-board-tab:TSK-1") ?? "{}")).toMatchObject({ version: 1, depth: "all" })
    first.dispose()
    document.body.innerHTML = ""

    // A reload: a new mount reads the record.
    mount("/", tabRoutes())
    await screen.findByTestId("board-card-TSK-4")
    expect(screen.getByTestId("sub-board-depth-all").getAttribute("data-selected")).toBe("true")
  })

  it("keeps its filters in the record, not in the address and not in the main board's remembered filters", async () => {
    writeSubBoardTabState("TSK-1", { depth: "children", search: "q=schema" })
    mount("/", tabRoutes())
    await screen.findByTestId("board-card-TSK-2")
    await waitFor(() => expect(listWorkItems.mock.calls.some(([params]) => (params as ListParams).q === "schema")).toBe(true))
    expect(where()).toBe("/")
    expect(localStorage.getItem(BOARD_FILTERS_STORAGE_KEY)).toBeNull()
  })

  it("is one record per Todo: another Todo's tab starts at the top", async () => {
    writeSubBoardTabState("TSK-1", { depth: "all", search: "" })
    expect(readSubBoardTabState("TSK-2")).toEqual({ depth: "children", search: "" })
  })

  it("opens a card as the Todo's page where the layout cannot take a tab, and stays where it is", async () => {
    const router = mount("/", tabRoutes())
    fireEvent.click(await screen.findByTestId("board-card-TSK-2"))
    await waitFor(() => expect(where()).toBe("/todos/TSK-2"))
    expect(router.state.historyAction).toBe("PUSH")
  })

  it("shows a calm 'not available' state for a Todo that is gone or not visible", async () => {
    rootMissing = true
    mount("/", tabRoutes())
    const note = await screen.findByTestId("sub-board-tab-unavailable")
    expect(note.textContent).toContain("This Todo's board isn't available")
    expect(screen.queryByTestId("todo-board-scroll")).toBeNull()
  })
})

describe("the pop-up's Pin as tab", () => {
  const popupRoutes = (onClose = vi.fn()): RouteObject[] => [
    { path: "/todos/:todoId", element: <><SubBoardDialog rootId="TSK-1" onClose={onClose} closeOnOpenTodo={false} /><Where /></> },
    { path: "/", element: <Where /> },
  ]

  it("pins in the layout when the pop-up is inside one, and closes the pop-up", async () => {
    const pin = vi.fn(() => true)
    const onClose = vi.fn()
    mount("/todos/TSK-1", [{ path: "/todos/:todoId", element: <TodoBoardTabContext.Provider value={pin}><SubBoardDialog rootId="TSK-1" onClose={onClose} /></TodoBoardTabContext.Provider> }])
    fireEvent.click(await screen.findByTestId("sub-board-pin"))
    expect(pin).toHaveBeenCalledWith("TSK-1")
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("leaves the pop-up where it is when the layout cannot take the tab", async () => {
    const pin = vi.fn(() => false)
    const onClose = vi.fn()
    mount("/todos/TSK-1", [{ path: "/todos/:todoId", element: <TodoBoardTabContext.Provider value={pin}><SubBoardDialog rootId="TSK-1" onClose={onClose} /></TodoBoardTabContext.Provider> }])
    fireEvent.click(await screen.findByTestId("sub-board-pin"))
    expect(onClose).not.toHaveBeenCalled()
  })

  it("asks the chat route for the tab, by a one-shot link, from the Todo's own page", async () => {
    const router = mount("/todos/TSK-1?view=board", popupRoutes())
    fireEvent.click(await screen.findByTestId("sub-board-pin"))
    await waitFor(() => expect(where()).toBe("/?open=todo-board:TSK-1"))
    expect(router.state.historyAction).toBe("PUSH")
  })

  it("is not offered to a board member, who has no chat layout to pin to: the Todo page and the pop-up stay", async () => {
    principal = { kind: "member", user: { id: "me", email: "me@example.test", displayName: "Mia Member" }, boards: [{ department: "platform", role: "owner" }] }
    mount("/todos/TSK-1?view=board", popupRoutes())
    await screen.findByTestId("board-card-TSK-2")
    expect(screen.queryByTestId("sub-board-pin")).toBeNull()
    // Nor from a layout that offers the pin: the member has no such layout, but the action is not theirs either way.
    expect(where()).toBe("/todos/TSK-1?view=board")
  })

  it("is not offered on a phone, where the full-screen pop-up is the board", async () => {
    phone(true)
    mount("/todos/TSK-1?view=board", popupRoutes())
    await screen.findByTestId("board-card-TSK-2")
    expect(screen.queryByTestId("sub-board-pin")).toBeNull()
  })
})

describe("the pop-up's Pin as tab at widths between the board's phone layout and the chat's", () => {
  afterEach(() => phone(false))

  it("is not offered at 900px, which the chat page lays out as mobile (no tab to land in)", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 900 })
    mount("/todos/TSK-1?view=board", [
      { path: "/todos/:todoId", element: <><SubBoardDialog rootId="TSK-1" onClose={vi.fn()} closeOnOpenTodo={false} /><Where /></> },
    ])
    await screen.findByTestId("board-card-TSK-2")
    expect(screen.queryByTestId("sub-board-pin")).toBeNull()
  })

  it("is offered at 1024px, the chat page's narrowest tab layout", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 })
    mount("/todos/TSK-1?view=board", [
      { path: "/todos/:todoId", element: <><SubBoardDialog rootId="TSK-1" onClose={vi.fn()} closeOnOpenTodo={false} /><Where /></> },
    ])
    await screen.findByTestId("board-card-TSK-2")
    expect(screen.getByTestId("sub-board-pin")).toBeTruthy()
  })
})

describe("the pop-up as an address (?view=board)", () => {
  /** What the Todo's page does with the pop-up (task-page.tsx), with the page itself left out. */
  function Page() {
    const view = useSubBoardView(false)
    return (
      <>
        <button type="button" data-testid="open" onClick={view.show}>open</button>
        {view.open && <SubBoardDialog rootId="TSK-1" onClose={view.hide} closeOnOpenTodo={false} />}
        <Where />
      </>
    )
  }
  const routes: RouteObject[] = [{ path: "/todos/:todoId", element: <Page /> }]

  it("opens from a link, and closing it drops the parameter with a replace", async () => {
    const router = mount("/todos/TSK-1?view=board", routes)
    await screen.findByTestId("sub-board-dialog")
    fireEvent.keyDown(screen.getByTestId("sub-board-dialog"), { key: "Escape" })
    await waitFor(() => expect(screen.queryByTestId("sub-board-dialog")).toBeNull())
    expect(where()).toBe("/todos/TSK-1")
    expect(router.state.historyAction).toBe("REPLACE")
  })

  it("opens from the button with a push, so Back closes it", async () => {
    const router = mount("/todos/TSK-1", routes)
    expect(screen.queryByTestId("sub-board-dialog")).toBeNull()
    fireEvent.click(screen.getByTestId("open"))
    await screen.findByTestId("sub-board-dialog")
    expect(where()).toBe("/todos/TSK-1?view=board")
    expect(router.state.historyAction).toBe("PUSH")
    await act(async () => { await router.navigate(-1) })
    await waitFor(() => expect(screen.queryByTestId("sub-board-dialog")).toBeNull())
    expect(where()).toBe("/todos/TSK-1")
  })

  it("keeps the rest of the address when it opens and closes", async () => {
    mount("/todos/TSK-1?tab=activity", routes)
    fireEvent.click(screen.getByTestId("open"))
    await screen.findByTestId("sub-board-dialog")
    expect(where()).toBe("/todos/TSK-1?tab=activity&view=board")
    fireEvent.keyDown(screen.getByTestId("sub-board-dialog"), { key: "Escape" })
    await waitFor(() => expect(where()).toBe("/todos/TSK-1?tab=activity"))
  })

  it("keeps the page's route state when it opens and when it closes (where it was opened from, its Back target)", async () => {
    const opened = { fromBoard: "subtree:TSK-9", returnBack: true }
    mount({ pathname: "/todos/TSK-1", state: opened }, routes)
    expect(stateOf()).toEqual(opened)
    fireEvent.click(screen.getByTestId("open"))
    await screen.findByTestId("sub-board-dialog")
    expect(where()).toBe("/todos/TSK-1?view=board")
    expect(stateOf()).toMatchObject(opened)
    fireEvent.keyDown(screen.getByTestId("sub-board-dialog"), { key: "Escape" })
    await waitFor(() => expect(where()).toBe("/todos/TSK-1"))
    expect(stateOf()).toEqual(opened)
  })

  it("keeps the route state when a pop-up opened by a link closes (a replace: there is no earlier entry of the page)", async () => {
    const opened = { fromBoard: "platform" }
    const router = mount({ pathname: "/todos/TSK-1", search: "?view=board", state: opened }, routes)
    await screen.findByTestId("sub-board-dialog")
    fireEvent.keyDown(screen.getByTestId("sub-board-dialog"), { key: "Escape" })
    await waitFor(() => expect(where()).toBe("/todos/TSK-1"))
    expect(stateOf()).toEqual(opened)
    expect(router.state.historyAction).toBe("REPLACE")
  })

  it("closing a pop-up the button opened leaves the page one entry: Back from it goes where the page was opened from", async () => {
    const opened = { fromBoard: "platform" }
    const router = mount([{ pathname: "/todos" }, { pathname: "/todos/TSK-1", state: opened }], [{ path: "/todos", element: <Where /> }, ...routes])
    fireEvent.click(screen.getByTestId("open"))
    await screen.findByTestId("sub-board-dialog")
    fireEvent.keyDown(screen.getByTestId("sub-board-dialog"), { key: "Escape" })
    await waitFor(() => expect(screen.queryByTestId("sub-board-dialog")).toBeNull())
    expect(where()).toBe("/todos/TSK-1")
    expect(stateOf()).toEqual(opened)
    await act(async () => { await router.navigate(-1) })
    expect(where()).toBe("/todos")
  })

  it("closing twice before the first close lands goes back once, never past the page", async () => {
    function DoubleClose() {
      const view = useSubBoardView(false)
      return (
        <>
          <button type="button" data-testid="open" onClick={view.show}>open</button>
          <button type="button" data-testid="close-twice" onClick={() => { view.hide(); view.hide() }}>close</button>
          {view.open && <SubBoardDialog rootId="TSK-1" onClose={view.hide} closeOnOpenTodo={false} />}
          <Where />
        </>
      )
    }
    const router = mount(
      [{ pathname: "/todos" }, { pathname: "/todos/TSK-1" }],
      [{ path: "/todos", element: <Where /> }, { path: "/todos/:todoId", element: <DoubleClose /> }],
    )
    fireEvent.click(screen.getByTestId("open"))
    await screen.findByTestId("sub-board-dialog")
    fireEvent.click(screen.getByTestId("close-twice"))
    await waitFor(() => expect(screen.queryByTestId("sub-board-dialog")).toBeNull())
    expect(where()).toBe("/todos/TSK-1")
    // The guard is per open: the pop-up opens and closes again from the same page.
    fireEvent.click(screen.getByTestId("open"))
    await screen.findByTestId("sub-board-dialog")
    fireEvent.click(screen.getByTestId("close-twice"))
    await waitFor(() => expect(screen.queryByTestId("sub-board-dialog")).toBeNull())
    expect(where()).toBe("/todos/TSK-1")
    await act(async () => { await router.navigate(-1) })
    expect(where()).toBe("/todos")
  })

  it("a pop-up brought back by Forward after a close closes again, by the button and by Escape", async () => {
    const router = mount([{ pathname: "/todos" }, { pathname: "/todos/TSK-1" }], [{ path: "/todos", element: <Where /> }, ...routes])
    fireEvent.click(screen.getByTestId("open"))
    await screen.findByTestId("sub-board-dialog")
    fireEvent.keyDown(screen.getByTestId("sub-board-dialog"), { key: "Escape" })
    await waitFor(() => expect(screen.queryByTestId("sub-board-dialog")).toBeNull())
    expect(where()).toBe("/todos/TSK-1")
    // Forward brings back the entry the close left, with the same key.
    await act(async () => { await router.navigate(1) })
    await screen.findByTestId("sub-board-dialog")
    expect(where()).toBe("/todos/TSK-1?view=board")
    fireEvent.keyDown(screen.getByTestId("sub-board-dialog"), { key: "Escape" })
    await waitFor(() => expect(screen.queryByTestId("sub-board-dialog")).toBeNull())
    expect(where()).toBe("/todos/TSK-1")
    await act(async () => { await router.navigate(1) })
    await screen.findByTestId("sub-board-dialog")
    fireEvent.click(within(screen.getByTestId("sub-board-dialog")).getAllByRole("button", { name: /^close$/i })[0])
    await waitFor(() => expect(screen.queryByTestId("sub-board-dialog")).toBeNull())
    expect(where()).toBe("/todos/TSK-1")
    await act(async () => { await router.navigate(-1) })
    expect(where()).toBe("/todos")
  })

  it("closing a linked pop-up twice stays on the page", async () => {
    function DoubleClose() {
      const view = useSubBoardView(false)
      return (
        <>
          <button type="button" data-testid="close-twice" onClick={() => { view.hide(); view.hide() }}>close</button>
          {view.open && <SubBoardDialog rootId="TSK-1" onClose={view.hide} closeOnOpenTodo={false} />}
          <Where />
        </>
      )
    }
    mount("/todos/TSK-1?view=board", [{ path: "/todos/:todoId", element: <DoubleClose /> }])
    await screen.findByTestId("sub-board-dialog")
    fireEvent.click(screen.getByTestId("close-twice"))
    await waitFor(() => expect(screen.queryByTestId("sub-board-dialog")).toBeNull())
    expect(where()).toBe("/todos/TSK-1")
  })

  it("a card opens its Todo by the one move, and Back returns to the board still open", async () => {
    const router = mount("/todos/TSK-1", [...routes, { path: "/todos/:todoId", element: <Page /> }])
    fireEvent.click(screen.getByTestId("open"))
    fireEvent.click(await screen.findByTestId("board-card-TSK-2"))
    await waitFor(() => expect(where()).toBe("/todos/TSK-2"))
    // The pop-up belongs to the page it was opened over, not to the Todo it led to.
    expect(screen.queryByTestId("sub-board-dialog")).toBeNull()
    await act(async () => { await router.navigate(-1) })
    await screen.findByTestId("sub-board-dialog")
    expect(where()).toBe("/todos/TSK-1?view=board")
  })
})
