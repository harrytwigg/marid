import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { DocView } from "../doc-view"

/* The Todos board tab is drawn by its own lazily loaded view. */

vi.mock("@/routes/todos/board/todos-tab-view", () => ({
  default: () => <div data-testid="todos-view">the board</div>,
}))

describe("DocView", () => {
  it("shows the Todos board for the Todos tab", async () => {
    render(<DocView doc={{ kind: "todos" }} />)
    expect((await screen.findByTestId("todos-view")).textContent).toBe("the board")
  })
})
