import { act, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/* The new-Todo dialog loads on demand. Each case gets a fresh copy of the lazy module, so it sees its own mocked
 * chunk: one that arrives when the test lets it, one that never can. */

beforeEach(() => vi.resetModules())
afterEach(() => vi.doUnmock("../new-todo-dialog"))

const props = { onClose: vi.fn(), onCreated: vi.fn(), defaults: { employees: [], departments: [] } }

describe("LazyNewTodoDialog", () => {
  it("stands an inert scrim in until the chunk arrives, then shows the dialog", async () => {
    let arrive: () => void = () => {}
    const gate = new Promise<void>((resolve) => { arrive = resolve })
    vi.doMock("../new-todo-dialog", async () => {
      await gate
      return { NewTodoDialog: () => <div data-testid="todo-new-title">dialog</div> }
    })
    const { LazyNewTodoDialog } = await import("../new-todo-dialog-lazy")
    render(<LazyNewTodoDialog {...props} onFailed={vi.fn()} />)

    const scrim = screen.getByTestId("todo-new-loading")
    expect(scrim.className).toContain("pointer-events-none")
    expect(scrim.querySelector("button, a, input, [tabindex]")).toBeNull()

    await act(async () => arrive())
    await screen.findByTestId("todo-new-title")
    expect(screen.queryByTestId("todo-new-loading")).toBeNull()
  })

  it("takes the scrim down and says so when the chunk cannot be fetched", async () => {
    vi.doMock("../new-todo-dialog", () => {
      throw new Error("Failed to fetch dynamically imported module")
    })
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { LazyNewTodoDialog } = await import("../new-todo-dialog-lazy")
    const onFailed = vi.fn()
    const notice = vi.fn()
    // Each case has its own copy of the modules, so the surface is registered on the copy the dialog reads.
    const { registerHostNotificationSink } = await import("@/plugins/sdk/host-bridge")
    registerHostNotificationSink(notice)
    render(<LazyNewTodoDialog {...props} onFailed={onFailed} />)

    await waitFor(() => expect(onFailed).toHaveBeenCalledTimes(1))
    expect(notice).toHaveBeenCalledWith({ title: "The new Todo dialog couldn't load. Reload the page and try again.", level: "error" })
    expect(screen.queryByTestId("todo-new-loading")).toBeNull()
  })

  it("preloads without throwing, and reports nothing, when the chunk cannot be fetched", async () => {
    vi.doMock("../new-todo-dialog", () => {
      throw new Error("offline")
    })
    const { preloadNewTodoDialog } = await import("../new-todo-dialog-lazy")
    expect(() => preloadNewTodoDialog()).not.toThrow()
  })
})
