import "@/test/preload-dialogs"
import { useState } from "react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { PickerSheet } from "../pickers/picker-shell"
import { TodoDialog } from "../todo-dialog"

/* The phone's picker sheet is a modal of its own: opened over a Todo dialog it nests in it, and when it closes
 * the dialog is still there and focus is back on what opened the sheet. */

function Harness() {
  const [picking, setPicking] = useState(false)
  return (
    <TodoDialog open label="Edit" testId="dialog" onRequestClose={() => {}} onClosed={() => {}}>
      <button type="button" onClick={() => setPicking(true)}>Priority</button>
      {picking && (
        <PickerSheet title="Priority" onClose={() => setPicking(false)} testId="sheet">
          <button type="button" data-picker-row onClick={() => setPicking(false)}>High</button>
          <button type="button" data-picker-row>Low</button>
        </PickerSheet>
      )}
    </TodoDialog>
  )
}

describe("PickerSheet over a Todo dialog", () => {
  it("opens as a dialog above it, takes focus, and Escape closes only the sheet", async () => {
    render(<Harness />)
    await screen.findByTestId("dialog")
    const opener = screen.getByRole("button", { name: "Priority" })
    opener.focus()
    fireEvent.click(opener)

    const sheet = await screen.findByRole("dialog", { name: "Priority" })
    await waitFor(() => expect(sheet.contains(document.activeElement)).toBe(true))

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })

    await waitFor(() => expect(screen.queryByTestId("sheet")).toBeNull())
    expect(screen.queryByTestId("dialog")).not.toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })

  it("moves between its rows with the arrow keys, and a choice closes it", async () => {
    render(<Harness />)
    fireEvent.click(await screen.findByRole("button", { name: "Priority" }))
    const high = await screen.findByRole("button", { name: "High" })
    await waitFor(() => expect(document.activeElement).toBe(high))

    fireEvent.keyDown(high, { key: "ArrowDown" })
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Low" }))

    fireEvent.click(high)
    await waitFor(() => expect(screen.queryByTestId("sheet")).toBeNull())
  })
})
