import { beforeEach, describe, it, expect } from "vitest"
import { TODOS_TAB_HREF } from "@/lib/todos-tab-entry"
import { TODOS_TAB_LOCATION_KEY, clearTodosTabLocationMemory, seedTodosTabLocation } from "../board/todos-tab-location"
import type { BoardId } from "../board/board-route"
import { render, screen } from "@testing-library/react"
import { MemoryRouter, Routes, Route, useParams } from "react-router-dom"
import { TodosIndexRedirect, legacyTodosRedirectTarget } from "../board/todos-index-redirect"

/* Slice 6 stage C — /todos IS the board surface (the index redirects into
 * Everything) and /todos/:todoId is the task page. The legacy list route is
 * gone; its lenses map onto the boards that superseded them. The route
 * arrangement mirrors main.tsx; the components are stand-ins. */

function BoardStub() {
  const { board } = useParams()
  return <div data-testid="board-page">{board}</div>
}

function Shell({ start }: { start: string }) {
  return (
    <MemoryRouter initialEntries={[start]}>
      <Routes>
        <Route path="/todos" element={<TodosIndexRedirect />} />
        <Route path="/todos/b/:board" element={<BoardStub />} />
        <Route path="/todos/:todoId" element={<div data-testid="task-page">Task</div>} />
      </Routes>
    </MemoryRouter>
  )
}

describe("legacyTodosRedirectTarget", () => {
  it("lands on Everything by default", () => {
    expect(legacyTodosRedirectTarget("")).toBe("/todos/b/everything")
  })
  it("maps the needs lens to the Attention board", () => {
    expect(legacyTodosRedirectTarget("?view=needs")).toBe("/todos/b/attention")
  })
  it("maps the retired people lens to Everything (superseded by department boards)", () => {
    expect(legacyTodosRedirectTarget("?view=people")).toBe("/todos/b/everything")
  })
  it("carries filter params through", () => {
    expect(legacyTodosRedirectTarget("?assignee=scout&view=needs")).toBe("/todos/b/attention?assignee=scout")
    expect(legacyTodosRedirectTarget("?department=platform")).toBe("/todos/b/everything?department=platform")
  })
})

describe("/todos route arrangement", () => {
  it("redirects /todos to the Everything board", () => {
    render(<Shell start="/todos" />)
    expect(screen.getByTestId("board-page").textContent).toBe("everything")
  })

  it("serves department boards at /todos/b/:board", () => {
    render(<Shell start="/todos/b/platform" />)
    expect(screen.getByTestId("board-page").textContent).toBe("platform")
  })

  it("serves the task page at /todos/:todoId", () => {
    render(<Shell start="/todos/TSK-12" />)
    expect(screen.getByTestId("task-page")).toBeTruthy()
  })

  it("a legacy people-lens deep link lands on the Everything board, never a dead route", () => {
    render(<Shell start="/todos?view=people" />)
    expect(screen.getByTestId("board-page").textContent).toBe("everything")
  })
})

// The /todos redirect must resolve at the ROUTER level (loader), never as a
// committed <Navigate> frame — an element redirect renders null for one commit
// and the mobile tab bar visibly flashed out on every chat → todos tap. The
// board is a tab of the chat route now, so the loader points the tab at the
// board the address names and sends the page to the chat route to open it.
describe("the board address loaders", () => {
  beforeEach(() => {
    localStorage.clear()
    clearTodosTabLocationMemory()
  })

  const seeded = () => JSON.parse(localStorage.getItem(TODOS_TAB_LOCATION_KEY) ?? "{}") as { board?: string; search?: string }
  /** The tab is somewhere else already, so a seed is a move the store records. */
  const startOnPlatform = () => seedTodosTabLocation({ kind: "department", slug: "platform" } satisfies BoardId, "q=old")

  it("sends a bare /todos to the chat route's Todos tab and leaves the tab on the board it was on", async () => {
    startOnPlatform()
    const { todosIndexLoader } = await import("../board/todos-index-redirect")
    const res = (await todosIndexLoader({ request: new Request("http://x/todos"), params: {}, context: {} } as never)) as Response
    expect(res.status).toBe(302)
    expect(res.headers.get("Location")).toBe(TODOS_TAB_HREF)
    expect(seeded()).toMatchObject({ board: "platform", search: "q=old" })
  })

  it("leaves the tab alone for a bare legacy /kanban, and for a bare query mark", async () => {
    startOnPlatform()
    const { todosIndexLoader } = await import("../board/todos-index-redirect")
    for (const url of ["http://x/kanban", "http://x/todos?"]) {
      const res = (await todosIndexLoader({ request: new Request(url), params: {}, context: {} } as never)) as Response
      expect(res.headers.get("Location")).toBe(TODOS_TAB_HREF)
    }
    expect(seeded()).toMatchObject({ board: "platform", search: "q=old" })
  })

  it("seeds the tab from /todos when it carries filters", async () => {
    startOnPlatform()
    const { todosIndexLoader } = await import("../board/todos-index-redirect")
    const res = (await todosIndexLoader({ request: new Request("http://x/todos?assignee=scout"), params: {}, context: {} } as never)) as Response
    expect(res.headers.get("Location")).toBe(TODOS_TAB_HREF)
    expect(seeded()).toMatchObject({ board: "everything", search: "assignee=scout" })
  })

  it("carries legacy view params to their mapped boards, keeping other filters", async () => {
    const { todosIndexLoader } = await import("../board/todos-index-redirect")
    const res = (await todosIndexLoader({ request: new Request("http://x/todos?view=needs&q=a"), params: {}, context: {} } as never)) as Response
    expect(res.headers.get("Location")).toBe(TODOS_TAB_HREF)
    expect(seeded()).toMatchObject({ board: "attention", search: "q=a" })
  })

  it("opens a department board's address as the tab on that board, with its filters", async () => {
    const { todosBoardLoader } = await import("../board/todos-index-redirect")
    const res = (await todosBoardLoader({ request: new Request("http://x/todos/b/platform?assignee=scout&date=week"), params: { board: "platform" }, context: {} } as never)) as Response
    expect(res.headers.get("Location")).toBe(TODOS_TAB_HREF)
    expect(seeded()).toMatchObject({ board: "platform", search: "assignee=scout&date=week" })
  })

  it("lands an unknown board on Everything rather than a dead tab", async () => {
    startOnPlatform()
    const { todosBoardLoader } = await import("../board/todos-index-redirect")
    await todosBoardLoader({ request: new Request("http://x/todos/b/%20"), params: { board: " " }, context: {} } as never)
    expect(seeded()).toMatchObject({ board: "everything" })
  })
})
