import { render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DocView } from "../doc-view"

/* A document tab fails on its own: whatever its view throws, the chat it sits
 * beside keeps rendering. */

vi.mock("@/routes/todos/task-page/task-page", () => ({
  TaskView: ({ todoId }: { todoId: string }) => {
    if (todoId === "ACM-9") throw new Error("view failed")
    return <div data-testid="todo-view">{todoId}</div>
  },
}))

afterEach(() => vi.restoreAllMocks())

describe("DocView", () => {
  it("contains a Todo view that throws to its own tab", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    render(
      <div>
        <div data-testid="chat">the chat</div>
        <DocView doc={{ kind: "todo", todoId: "ACM-9" }} />
      </div>,
    )

    expect((await screen.findByTestId("doc-view-error")).textContent).toContain("Couldn't show this Todo")
    expect(screen.getByTestId("chat").textContent).toBe("the chat")
  })

  it("starts the next document clean after one failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const view = render(<DocView doc={{ kind: "todo", todoId: "ACM-9" }} />)
    await screen.findByTestId("doc-view-error")

    view.rerender(<DocView doc={{ kind: "todo", todoId: "ACM-1" }} />)

    expect((await screen.findByTestId("todo-view")).textContent).toBe("ACM-1")
    expect(screen.queryByTestId("doc-view-error")).toBeNull()
  })
})
