import { useState } from "react"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "../dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../select"

beforeAll(() => {
  Element.prototype.scrollIntoView ??= () => {}
})

function Example({ onChange = () => {}, initial = "b" }: { onChange?: (value: string) => void; initial?: string }) {
  const [value, setValue] = useState(initial)
  return (
    <>
      <Select
        value={value}
        onValueChange={(next) => {
          setValue(next)
          onChange(next)
        }}
      >
        <SelectTrigger aria-label="Fruit">
          <SelectValue placeholder="Pick one" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">Apple</SelectItem>
          <SelectItem value="b">Banana</SelectItem>
          <SelectItem value="c" disabled>
            Cherry
          </SelectItem>
          <SelectItem value="d">Date <span>· dried</span></SelectItem>
        </SelectContent>
      </Select>
      <button type="button">Elsewhere</button>
    </>
  )
}

const trigger = () => screen.getByRole("combobox", { name: "Fruit", hidden: true })
const dialog = () => document.querySelector<HTMLElement>("[data-slot=dialog-content]")

describe("Select", () => {
  it("shows the selected item in the trigger and offers the items on a press", async () => {
    render(<Example />)
    expect(trigger().textContent).toBe("Banana")
    expect(trigger().getAttribute("aria-expanded")).toBe("false")

    await userEvent.click(trigger())

    const options = await screen.findAllByRole("option")
    expect(options.map((o) => o.textContent)).toEqual(["Apple", "Banana", "Cherry", "Date · dried"])
    expect(screen.getByRole("option", { name: "Banana" }).getAttribute("aria-selected")).toBe("true")
    expect(options[2]!.getAttribute("aria-disabled")).toBe("true")
    // The page behind a select is hidden from assistive technology while it is open.
    expect(screen.getByRole("combobox", { name: "Fruit", hidden: true }).getAttribute("aria-expanded")).toBe("true")
  })

  it("shows the placeholder while nothing matches the value", () => {
    render(<Example initial="none" />)
    expect(trigger().textContent).toBe("Pick one")
  })

  it("chooses with the keyboard: ArrowDown opens, arrows move over a disabled item, Enter chooses and closes", async () => {
    const onChange = vi.fn()
    render(<Example onChange={onChange} />)
    trigger().focus()

    await userEvent.keyboard("{ArrowDown}")
    await screen.findByRole("listbox")
    await userEvent.keyboard("{ArrowDown}") // Banana is focused on open; the next enabled item skips Cherry
    expect(document.activeElement).toBe(screen.getByRole("option", { name: /Date/ }))
    await userEvent.keyboard("{Enter}")

    expect(onChange).toHaveBeenCalledWith("d")
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull())
    expect(trigger().textContent).toBe("Date · dried")
    await waitFor(() => expect(document.activeElement).toBe(trigger()))
  })

  it("jumps to the item a typed letter starts", async () => {
    render(<Example />)
    await userEvent.click(trigger())
    await screen.findByRole("listbox")

    await userEvent.keyboard("a")
    expect(document.activeElement).toBe(screen.getByRole("option", { name: "Apple" }))
  })

  it("does not choose a disabled item", async () => {
    const onChange = vi.fn()
    render(<Example onChange={onChange} />)
    await userEvent.click(trigger())

    await userEvent.click(await screen.findByRole("option", { name: "Cherry" }))

    expect(onChange).not.toHaveBeenCalled()
    expect(screen.queryByRole("listbox")).not.toBeNull()
  })

  it("closes on Escape and puts focus back on the trigger", async () => {
    render(<Example />)
    await userEvent.click(trigger())
    await screen.findByRole("listbox")

    await userEvent.keyboard("{Escape}")

    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger()))
  })

  it("closes on a press outside without choosing", async () => {
    const onChange = vi.fn()
    render(<Example onChange={onChange} />)
    await userEvent.click(trigger())
    await screen.findByRole("listbox")

    await userEvent.click(document.body)

    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull())
    expect(onChange).not.toHaveBeenCalled()
  })

  it("does not open when disabled", async () => {
    render(
      <Select value="a" disabled>
        <SelectTrigger aria-label="Fruit">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">Apple</SelectItem>
        </SelectContent>
      </Select>,
    )
    await userEvent.click(trigger())
    expect(screen.queryByRole("listbox")).toBeNull()
    expect((trigger() as HTMLButtonElement).disabled).toBe(true)
  })
})

describe("Select inside a dialog", () => {
  function InDialog({ onChange }: { onChange: (value: string) => void }) {
    return (
      <Dialog>
        <DialogTrigger asChild>
          <button type="button">Open dialog</button>
        </DialogTrigger>
        <DialogContent showCloseButton={false}>
          <DialogTitle>Settings</DialogTitle>
          <Example onChange={onChange} />
        </DialogContent>
      </Dialog>
    )
  }

  async function open() {
    await userEvent.click(screen.getByRole("button", { name: "Open dialog" }))
    await waitFor(() => expect(dialog()).not.toBeNull())
    await userEvent.click(trigger())
    return screen.findByRole("listbox")
  }

  it("opens inside the dialog's content and can be pressed", async () => {
    const onChange = vi.fn()
    render(<InDialog onChange={onChange} />)
    const list = await open()
    expect(dialog()?.contains(list)).toBe(true)

    await userEvent.click(screen.getByRole("option", { name: "Apple" }))

    expect(onChange).toHaveBeenCalledWith("a")
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull())
    expect(dialog()).not.toBeNull()
  })

  it("Escape closes the list first and leaves the dialog open", async () => {
    render(<InDialog onChange={() => {}} />)
    await open()

    await userEvent.keyboard("{Escape}")

    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull())
    expect(dialog()).not.toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(trigger()))
  })
})
