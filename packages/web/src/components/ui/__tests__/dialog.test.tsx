import "@/test/preload-dialogs"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "../dialog"

function Example({ onOpenChange, ...content }: { onOpenChange?: (open: boolean) => void } & Partial<React.ComponentProps<typeof DialogContent>>) {
  return (
    <Dialog onOpenChange={onOpenChange}>
      <DialogTrigger>Open</DialogTrigger>
      <DialogContent data-testid="box" {...content}>
        <DialogTitle>Title</DialogTitle>
        <DialogDescription>About it</DialogDescription>
        <input aria-label="First field" />
        <DialogClose asChild>
          <button type="button">Done</button>
        </DialogClose>
      </DialogContent>
    </Dialog>
  )
}

describe("Dialog", () => {
  it("is a modal named by its title and described by its description, and its trigger says so", async () => {
    render(<Example />)
    const trigger = screen.getByRole("button", { name: "Open" })
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog")
    expect(trigger.getAttribute("aria-expanded")).toBe("false")

    await userEvent.click(trigger)

    const dialog = await screen.findByRole("dialog", { name: "Title" })
    expect(dialog.getAttribute("aria-describedby")).toBe(screen.getByText("About it").id)
    expect(trigger.getAttribute("aria-expanded")).toBe("true")
    expect(trigger.getAttribute("aria-controls")).toBe(dialog.id)
  })

  it("moves focus to its first control and gives it back to the trigger on close", async () => {
    render(<Example />)
    const trigger = screen.getByRole("button", { name: "Open" })
    trigger.focus()
    await userEvent.click(trigger)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("First field")))

    await userEvent.click(screen.getByRole("button", { name: "Done" }))

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it("leaves focus on the dialog when onOpenAutoFocus prevents it", async () => {
    render(<Example onOpenAutoFocus={(event) => event.preventDefault()} />)
    await userEvent.click(screen.getByRole("button", { name: "Open" }))
    const dialog = await screen.findByRole("dialog")
    await waitFor(() => expect(document.activeElement).toBe(dialog))
  })

  it("closes on Escape, unless onEscapeKeyDown prevents it", async () => {
    const onEscapeKeyDown = vi.fn((event: KeyboardEvent) => event.preventDefault())
    render(<Example onEscapeKeyDown={onEscapeKeyDown} />)
    await userEvent.click(screen.getByRole("button", { name: "Open" }))
    await screen.findByRole("dialog")

    fireEvent.keyDown(document, { key: "Escape" })
    expect(onEscapeKeyDown).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole("dialog")).not.toBeNull()

    onEscapeKeyDown.mockImplementation(() => {})
    fireEvent.keyDown(document, { key: "Escape" })
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("closes on a press on the scrim, but not for an alert dialog", async () => {
    const onOpenChange = vi.fn()
    const { unmount } = render(<Example onOpenChange={onOpenChange} role="alertdialog" dismissable={false} />)
    await userEvent.click(screen.getByRole("button", { name: "Open" }))
    const alert = await screen.findByRole("alertdialog")
    expect(alert).toBeTruthy()
    await userEvent.click(document.querySelector("[data-slot=dialog-overlay]")!)
    expect(screen.queryByRole("alertdialog")).not.toBeNull()
    unmount()

    render(<Example />)
    await userEvent.click(screen.getByRole("button", { name: "Open" }))
    await screen.findByRole("dialog")
    await userEvent.click(document.querySelector("[data-slot=dialog-overlay]")!)
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("answers the Escape of the innermost of two dialogs only", async () => {
    render(
      <Dialog defaultOpen>
        <DialogContent data-testid="outer" showCloseButton={false}>
          <DialogTitle>Outer</DialogTitle>
          <Dialog>
            <DialogTrigger>Open inner</DialogTrigger>
            <DialogContent data-testid="inner" showCloseButton={false}>
              <DialogTitle>Inner</DialogTitle>
            </DialogContent>
          </Dialog>
        </DialogContent>
      </Dialog>,
    )
    await userEvent.click(await screen.findByRole("button", { name: "Open inner" }))
    await screen.findByTestId("inner")

    fireEvent.keyDown(document, { key: "Escape" })

    await waitFor(() => expect(screen.queryByTestId("inner")).toBeNull())
    expect(screen.queryByTestId("outer")).not.toBeNull()
  })

  it("hides the corner close button on request", async () => {
    render(<Example showCloseButton={false} />)
    await userEvent.click(screen.getByRole("button", { name: "Open" }))
    await screen.findByRole("dialog")
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull()
  })

  it("keeps what is inside when a key handler is added to an open dialog", async () => {
    const { rerender } = render(<Example />)
    await userEvent.click(screen.getByRole("button", { name: "Open" }))
    const field = (await screen.findByLabelText("First field")) as HTMLInputElement
    await userEvent.type(field, "kept")

    rerender(<Example onKeyDown={() => {}} />)

    expect(screen.getByLabelText("First field")).toBe(field)
    expect(field.value).toBe("kept")
  })
})
