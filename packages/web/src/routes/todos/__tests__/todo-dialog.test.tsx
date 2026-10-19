import { useState } from "react"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import "@/test/preload-dialogs"
import { TodoDialog } from "../todo-dialog"

/** React Aria asks each element it is about to drop what it is animating. jsdom runs no animation, so a test that
 *  wants an exit has to hand it one, and says when it ends. */
function stubExitAnimation(): () => void {
  let end: () => void = () => {}
  const finished = new Promise<void>((resolve) => { end = resolve })
  vi.spyOn(Element.prototype, "getAnimations").mockReturnValue([{ playState: "running", finished }] as unknown as Animation[])
  return end
}

function Harness({ onClosed }: { onClosed?: () => void }) {
  const [phase, setPhase] = useState<"gone" | "open" | "leaving">("gone")
  return (
    <>
      <button type="button" onClick={() => setPhase("open")}>Open details</button>
      {phase !== "gone" && (
        <TodoDialog
          label="Todo details"
          testId="todo-details"
          open={phase === "open"}
          onRequestClose={() => setPhase("leaving")}
          onClosed={() => { setPhase("gone"); onClosed?.() }}
        >
          <button type="button">First action</button>
          <button type="button">Last action</button>
        </TodoDialog>
      )}
    </>
  )
}

function open(): void {
  const opener = screen.getByRole("button", { name: "Open details" })
  opener.focus()
  fireEvent.click(opener)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("TodoDialog focus scope", () => {
  it("traps focus, closes on Escape, and restores focus to the opener", async () => {
    render(<Harness />)
    const opener = screen.getByRole("button", { name: "Open details" })
    open()
    const dialog = await screen.findByRole("dialog", { name: "Todo details" })
    const first = screen.getByRole("button", { name: "First action" })
    await waitFor(() => expect(document.activeElement).toBe(dialog))

    const last = screen.getByRole("button", { name: "Last action" })
    last.focus()
    fireEvent.keyDown(last, { key: "Tab" })
    expect(document.activeElement).toBe(first)

    fireEvent.keyDown(dialog, { key: "Escape" })
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })
})

describe("TodoDialog exit", () => {
  it("stays on screen, marked as leaving, until its exit animation ends", async () => {
    const onClosed = vi.fn()
    render(<Harness onClosed={onClosed} />)
    open()
    const dialog = await screen.findByTestId("todo-details")
    const endExit = stubExitAnimation()

    fireEvent.keyDown(dialog, { key: "Escape" })

    await waitFor(() => expect(document.querySelector("[data-exiting]")).not.toBeNull())
    expect(screen.queryByTestId("todo-details")).not.toBeNull()
    expect(onClosed).not.toHaveBeenCalled()

    await act(async () => endExit())

    await waitFor(() => expect(onClosed).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId("todo-details")).toBeNull()
  })

  it("leaves nothing behind when reduced motion removes the exit to wait for", async () => {
    // No animationend will ever fire, so holding the dialog for one would
    // strand it over the page with focus still trapped inside.
    const onClosed = vi.fn()
    render(<Harness onClosed={onClosed} />)
    open()
    const dialog = await screen.findByTestId("todo-details")

    fireEvent.keyDown(dialog, { key: "Escape" })

    await waitFor(() => expect(onClosed).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId("todo-details")).toBeNull()
  })
})
