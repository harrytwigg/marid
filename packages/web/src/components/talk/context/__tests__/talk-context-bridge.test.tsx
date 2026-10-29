import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { render, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { setTodosTabFocused } from "@/lib/todos-tab-focus"
import { clearTodosTabLocationMemory, seedTodosTabLocation } from "@/routes/todos/board/todos-tab-location"
import { TalkContextBridge } from "../talk-context-bridge"
import { getPageContext, resetPageContext } from "../page-context-store"

/** The bridge on the chat route, with the page's flag for the Todos tab in front set or not. */
function renderBridge(search = "?session=x") {
  return render(
    <MemoryRouter initialEntries={[`/${search}`]}>
      <TalkContextBridge />
    </MemoryRouter>,
    { container: document.getElementById("root") ?? document.body.appendChild(Object.assign(document.createElement("div"), { id: "root" })) },
  )
}

describe("the context bridge and the Todos tab", () => {
  beforeEach(() => {
    localStorage.clear()
    clearTodosTabLocationMemory()
    resetPageContext()
  })
  afterEach(() => setTodosTabFocused(false))

  it("describes the focused Todos tab as the board it shows, with the tab's own board and filters", async () => {
    seedTodosTabLocation({ kind: "department", slug: "platform" }, "assignee=scout")
    setTodosTabFocused(true)
    renderBridge()

    await waitFor(() => expect(getPageContext()).toMatchObject({ kind: "todos", params: { board: "platform" }, filters: { assignee: "scout" } }))
  })

  it("moves with the tab's board while it stays focused", async () => {
    setTodosTabFocused(true)
    renderBridge()
    await waitFor(() => expect(getPageContext()).toMatchObject({ kind: "todos", params: { board: "everything" } }))

    seedTodosTabLocation({ kind: "attention" }, "")

    await waitFor(() => expect(getPageContext()).toMatchObject({ kind: "todos", params: { board: "attention" } }))
  })

  it("describes the chat when the tab is not in front", async () => {
    renderBridge()
    await waitFor(() => expect(getPageContext()).toMatchObject({ kind: "chat", selection: { kind: "chat session", id: "x" } }))
  })
})
