import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { describe, expect, it, vi } from "vitest"
import { Popover, PopoverContent, PopoverTrigger } from "../popover"

function Example({ onOpenChange }: { onOpenChange?: (open: boolean) => void }) {
  return (
    <>
      <Popover onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <button type="button">Waiting on</button>
        </PopoverTrigger>
        <PopoverContent aria-label="What this is waiting on" data-testid="surface">
          <button type="button">Inside</button>
        </PopoverContent>
      </Popover>
      <button type="button">Elsewhere</button>
    </>
  )
}

/** React Aria hides everything outside an open popover from a screen reader,
 *  the trigger included, so it is found with `hidden`. */
const trigger = () => screen.getByRole("button", { name: "Waiting on", hidden: true })

describe("Popover", () => {
  it("is a named dialog the trigger announces, closed until it is asked for", async () => {
    render(<Example />)

    expect(screen.queryByRole("dialog")).toBeNull()
    expect(trigger().getAttribute("aria-expanded")).toBe("false")
    expect(trigger().getAttribute("aria-haspopup")).toBe("dialog")

    await userEvent.click(trigger())

    const dialog = await screen.findByRole("dialog", { name: "What this is waiting on" })
    expect(trigger().getAttribute("aria-expanded")).toBe("true")
    expect(trigger().getAttribute("aria-controls")).toBe(dialog.id)
  })

  it("opens from the keyboard, and Escape closes it and returns focus to the trigger", async () => {
    const onOpenChange = vi.fn()
    render(<Example onOpenChange={onOpenChange} />)

    await userEvent.tab()
    expect(document.activeElement).toBe(trigger())
    await userEvent.keyboard("{Enter}")
    await screen.findByRole("dialog")
    expect(onOpenChange).toHaveBeenLastCalledWith(true)
    // Focus went into the dialog, where Tab reaches what it holds.
    await userEvent.tab()
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Inside" }))

    await userEvent.keyboard("{Escape}")

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(onOpenChange).toHaveBeenLastCalledWith(false)
    await waitFor(() => expect(document.activeElement).toBe(trigger()))
  })

  it("opens from Space as well", async () => {
    render(<Example />)

    await userEvent.tab()
    await userEvent.keyboard(" ")

    await screen.findByRole("dialog")
  })

  it("closes on a press outside it", async () => {
    render(<Example />)
    await userEvent.click(trigger())
    await screen.findByRole("dialog")

    await userEvent.click(document.body)

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("hides the page from a screen reader while it is open and gives it back after", async () => {
    render(<Example />)
    await userEvent.click(trigger())
    await screen.findByRole("dialog")

    expect(screen.queryByRole("button", { name: "Elsewhere" })).toBeNull()

    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(screen.getByRole("button", { name: "Elsewhere" })).toBeTruthy()
  })

  it("can be controlled with `open` and `onOpenChange`", async () => {
    function Controlled() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Open it</button>
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <button type="button">Waiting on</button>
            </PopoverTrigger>
            <PopoverContent aria-label="Controlled">Body</PopoverContent>
          </Popover>
        </>
      )
    }
    render(<Controlled />)

    await userEvent.click(screen.getByRole("button", { name: "Open it" }))
    await screen.findByRole("dialog", { name: "Controlled" })

    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("passes data attributes and handlers to the surface, and draws on the overlay glass", async () => {
    const onClick = vi.fn()
    render(
      <Popover defaultOpen>
        <PopoverTrigger asChild>
          <button type="button">Waiting on</button>
        </PopoverTrigger>
        <PopoverContent aria-label="Surface" data-testid="surface" onClick={onClick} className="p-1.5">
          Body
        </PopoverContent>
      </Popover>,
    )

    const surface = await screen.findByTestId("surface")
    await userEvent.click(surface)

    expect(onClick).toHaveBeenCalled()
    expect(surface.classList.contains("popover")).toBe(true)
    expect(surface.classList.contains("glass-overlay")).toBe(true)
    expect(surface.classList.contains("p-1.5")).toBe(true)
    // The layer React Aria portals into; the table in overlay-layers.ts says where it sits.
    expect(surface.style.zIndex).toBe("100000")
  })
})
