import "@/test/preload-menus"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "../dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../dropdown-menu"

function Example({ onPick }: { onPick: () => void }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button type="button">Open dialog</button>
      </DialogTrigger>
      <DialogContent showCloseButton={false}>
        <DialogTitle>Settings</DialogTitle>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button">Options</button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onClick={onPick}>Pick me</DropdownMenuItem>
            <DropdownMenuItem>Other</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </DialogContent>
    </Dialog>
  )
}

async function openMenuInDialog() {
  await userEvent.click(screen.getByRole("button", { name: "Open dialog" }))
  await screen.findByRole("dialog")
  await userEvent.click(screen.getByRole("button", { name: "Options" }))
  return screen.findByRole("menu")
}

describe("a dropdown menu inside a dialog", () => {
  it("opens inside the dialog's content, where its focus and pointer rules reach it", async () => {
    render(<Example onPick={vi.fn()} />)

    const menu = await openMenuInDialog()

    expect(screen.getByRole("dialog").contains(menu)).toBe(true)
  })

  it("can be pressed even though the dialog blocks the page behind it", async () => {
    const onPick = vi.fn()
    render(<Example onPick={onPick} />)
    await openMenuInDialog()

    await userEvent.click(screen.getByRole("menuitem", { name: "Pick me" }))

    expect(onPick).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
    expect(screen.getByRole("dialog")).toBeTruthy()
  })

  it("holds focus: arrow keys move through the items", async () => {
    render(<Example onPick={vi.fn()} />)
    await openMenuInDialog()

    await userEvent.keyboard("{ArrowDown}")
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Pick me" }))
    await userEvent.keyboard("{ArrowDown}")
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Other" }))
  })

  it("Escape closes the menu first and leaves the dialog open, then the next closes the dialog", async () => {
    render(<Example onPick={vi.fn()} />)
    await openMenuInDialog()

    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
    expect(screen.queryByRole("dialog")).not.toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Options" })))

    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })
})
