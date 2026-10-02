import { describe, it, expect } from "vitest"
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
    render(<Shell start="/todos/PLA-12" />)
    expect(screen.getByTestId("task-page")).toBeTruthy()
  })

  it("a legacy people-lens deep link lands on the Everything board, never a dead route", () => {
    render(<Shell start="/todos?view=people" />)
    expect(screen.getByTestId("board-page").textContent).toBe("everything")
  })
})

// The /todos redirect must resolve at the ROUTER level (loader), never as a
// committed <Navigate> frame — an element redirect renders null for one commit
// and the mobile tab bar visibly flashed out on every chat → todos tap.
describe("todosIndexLoader", () => {
  it("redirects to the default board before anything commits", async () => {
    const { todosIndexLoader } = await import("../board/todos-index-redirect")
    const res = todosIndexLoader({ request: new Request("http://x/todos"), params: {}, context: {} } as never) as Response
    expect(res instanceof Response).toBe(true)
    expect(res.status).toBe(302)
    expect(res.headers.get("Location")).toBe("/todos/b/everything")
  })

  it("carries legacy view params to their mapped boards, keeping other filters", async () => {
    const { todosIndexLoader } = await import("../board/todos-index-redirect")
    const res = todosIndexLoader({ request: new Request("http://x/todos?view=needs&q=a"), params: {}, context: {} } as never) as Response
    expect(res.headers.get("Location")).toBe("/todos/b/attention?q=a")
  })
})
