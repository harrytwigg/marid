import { describe, expect, it } from "vitest"
import { describeLocation, type PageSnapshot } from "../page-snapshot"
import { PAGE_CONTEXT_BUDGET_CHARS, renderPageContext } from "../render-page-context"
import type { VisibleObject } from "../visible-objects"

const HERE = { name: "acme", port: "7778" }

function board(): PageSnapshot {
  return {
    ...describeLocation("/todos/b/platform", "?status=executing&assignee=a-lead&q=orb"),
    selection: { kind: "Todo", id: "ABC-744" },
  }
}

/** A board nobody would call small, with the titles operators actually write. */
function crowdedBoard(count: number): VisibleObject[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `ABC-${100 + index}`,
    title: `Talk v2.2 ambient page context so the orb always knows what the operator is looking at, part ${index + 1}`,
  }))
}

describe("rendering the page context", () => {
  it("names the instance and the port, so the orb never guesses which Jinn it is on", () => {
    const text = renderPageContext(board(), [], HERE)

    expect(text).toContain("acme")
    expect(text).toContain("7778")
  })

  it("carries the route, the filters and the selection", () => {
    const text = renderPageContext(board(), [], HERE)

    expect(text).toContain("/todos/b/platform")
    expect(text).toContain("board=platform")
    expect(text).toContain("status=executing")
    expect(text).toContain("assignee=a-lead")
    expect(text).toContain("q=orb")
    expect(text).toContain("ABC-744")
  })

  it("holds a 400-object board inside the budget, and says how many it dropped", () => {
    const text = renderPageContext(board(), crowdedBoard(400), HERE)

    expect(text.length).toBeLessThanOrEqual(PAGE_CONTEXT_BUDGET_CHARS)
    // The fixed part survives the trim; only the object list gives ground.
    expect(text).toContain("/todos/b/platform")
    expect(text).toContain("status=executing")
    expect(text).toContain("q=orb")
    expect(text).toContain("ABC-744")
    // Truncation is stated, never silent: a model that reads a cut list as the
    // whole board reports "12 Todos" for a board of 400.
    expect(text).toMatch(/\+\d+ more/)
    expect(text).toContain("ABC-100")
  })

  it("drops the object list whole rather than the route, when the fixed part fills the budget", () => {
    const overfilled: PageSnapshot = {
      kind: "todos",
      path: "/todos/b/platform",
      params: { board: "platform" },
      selection: { kind: "Todo", id: "ABC-744" },
      filters: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`filter${i}`, "value".repeat(30)])),
    }

    const text = renderPageContext(overfilled, crowdedBoard(400), HERE)

    expect(text.length).toBeLessThanOrEqual(PAGE_CONTEXT_BUDGET_CHARS)
    // Route and selection outrank both the filters and the object list.
    expect(text).toContain("/todos/b/platform")
    expect(text).toContain("ABC-744")
    expect(text).not.toMatch(/ABC-1\d\d /)
  })

  it("stays inside the budget for every surface, however long the operator's own strings are", () => {
    const long = "x".repeat(5000)
    for (const [pathname, search] of [
      ["/", `?session=${long}`],
      [`/todos/${long}`, ""],
      [`/cron/${long}`, ""],
      [`/notes/f/${long}/n/${long}`, ""],
      [`/${long}`, `?${long}=${long}`],
    ] as const) {
      const text = renderPageContext(describeLocation(pathname, search), crowdedBoard(400), HERE)
      expect(text.length).toBeLessThanOrEqual(PAGE_CONTEXT_BUDGET_CHARS)
    }
  })

  it("lists every object when they all fit, with no dropped-count marker", () => {
    const text = renderPageContext(board(), [{ id: "ABC-1", title: "Ship it" }], HERE)

    expect(text).toContain("ABC-1")
    expect(text).toContain("Ship it")
    expect(text).not.toMatch(/more/)
  })

  it("says nothing about objects when the cache had none to give", () => {
    expect(renderPageContext(board(), [], HERE)).not.toMatch(/On screen/)
  })

  /**
   * Journey step 1 (PLA-224). Asked "what are we looking at?", the model used
   * to narrate: it could read the chat's title off the packet but the session
   * id was deliberately withheld, so `read_session` was uncallable and there
   * was nothing to read. The handle is the difference between reading and
   * inventing.
   */
  it("carries the selected chat's session id, so the model can name it to a tool", () => {
    const id = "123e4567-e89b-12d3-a456-426614174000"
    const chat: PageSnapshot = {
      ...describeLocation("/", `?session=${id}`),
      selection: { kind: "chat session", id },
    }

    const text = renderPageContext(chat, [], HERE)
    const handle = text.split("\n").find((line) => line.startsWith("Selected session id:"))

    expect(text).toContain(`Selected session id: ${id}`)
    expect(text).toContain("a handle to use, never something to say")
    expect(handle).toBeDefined()
    expect(handle!.length).toBeLessThan(180)
    // The rule the packet states about speech is unchanged, and still true:
    // the id is for tool arguments, never for the answer.
    expect(text).toContain("not identifiers unless explicitly asked")
    expect(text.length).toBeLessThanOrEqual(PAGE_CONTEXT_BUDGET_CHARS)
  })

  it("says nothing about a session id on a page with no chat selected", () => {
    expect(renderPageContext(board(), [], HERE)).not.toContain("Selected session id")
  })

  it("keeps the handle inside the budget when the operator's own strings are absurd", () => {
    const id = "x".repeat(5000)
    const chat: PageSnapshot = {
      ...describeLocation("/", `?session=${id}`),
      selection: { kind: "chat session", id },
    }

    const text = renderPageContext(chat, crowdedBoard(400), HERE)

    expect(text.length).toBeLessThanOrEqual(PAGE_CONTEXT_BUDGET_CHARS)
    expect(text).toContain("Selected session id: ")
  })
})
