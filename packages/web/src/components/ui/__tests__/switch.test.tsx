import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createRef, useState } from "react"
import { describe, expect, it, vi } from "vitest"
import { Switch } from "../switch"

const input = (name: string) => screen.getByRole("switch", { name }) as HTMLInputElement

describe("Switch", () => {
  it("is a native checkbox with role=switch, so the state is `checked`", () => {
    render(<Switch aria-label="Notify" checked />)
    const control = input("Notify")

    expect(control.type).toBe("checkbox")
    expect(control.checked).toBe(true)
    expect(control.hasAttribute("aria-checked")).toBe(false)
  })

  it("calls onCheckedChange with the next value, from a click and from the keyboard", async () => {
    const onCheckedChange = vi.fn()
    function Controlled() {
      const [on, setOn] = useState(false)
      return <Switch aria-label="Notify" checked={on} onCheckedChange={(next) => { onCheckedChange(next); setOn(next) }} />
    }
    render(<Controlled />)

    await userEvent.click(input("Notify"))
    expect(onCheckedChange).toHaveBeenLastCalledWith(true)
    expect(input("Notify").checked).toBe(true)

    input("Notify").focus()
    await userEvent.keyboard(" ")
    expect(onCheckedChange).toHaveBeenLastCalledWith(false)
    expect(input("Notify").checked).toBe(false)
  })

  it("keeps its own state when only defaultChecked is given", async () => {
    render(<Switch aria-label="Notify" defaultChecked />)

    expect(input("Notify").checked).toBe(true)
    await userEvent.click(input("Notify"))
    expect(input("Notify").checked).toBe(false)
  })

  it("marks the root selected or disabled, which is what HeroUI's stylesheet keys the track on", () => {
    const { container, rerender } = render(<Switch aria-label="Notify" checked />)
    const root = () => container.querySelector('[data-slot="switch"]')!
    expect(root().getAttribute("data-selected")).toBe("true")
    expect(root().hasAttribute("data-disabled")).toBe(false)

    rerender(<Switch aria-label="Notify" checked={false} disabled />)
    expect(root().hasAttribute("data-selected")).toBe(false)
    expect(root().getAttribute("data-disabled")).toBe("true")
  })

  it("is reached by Tab on the input inside the label, where :focus-visible draws the ring", async () => {
    render(<Switch aria-label="Notify" checked={false} />)

    await userEvent.tab()
    expect(document.activeElement).toBe(input("Notify"))
    expect(input("Notify").closest('[data-slot="switch-content"]')).not.toBeNull()
  })

  it("can neither be clicked nor toggled from the keyboard when disabled", async () => {
    const onCheckedChange = vi.fn()
    render(<Switch aria-label="Notify" checked={false} disabled onCheckedChange={onCheckedChange} />)

    expect(input("Notify").disabled).toBe(true)
    await userEvent.click(input("Notify"))
    await userEvent.keyboard(" ")
    expect(onCheckedChange).not.toHaveBeenCalled()
  })

  it("keeps id, name and value on the input, where a label and a form look for them", () => {
    render(
      <form data-testid="form">
        <label htmlFor="notify">Notify me</label>
        <Switch id="notify" name="notify" value="yes" defaultChecked />
      </form>,
    )
    const control = screen.getByLabelText("Notify me") as HTMLInputElement

    expect(control.name).toBe("notify")
    expect(new FormData(screen.getByTestId("form") as HTMLFormElement).get("notify")).toBe("yes")
  })

  it("keeps the other props a caller passes: title, style, data attributes and a click handler land on the root", () => {
    const onClick = vi.fn()
    const { container } = render(
      <Switch aria-label="Notify" title="tip" style={{ opacity: 0.5 }} data-testid="sw" className="mine" onClick={onClick} />,
    )
    const root = container.querySelector('[data-slot="switch"]') as HTMLElement

    expect(root.getAttribute("title")).toBe("tip")
    expect(root.style.opacity).toBe("0.5")
    expect(root.dataset.testid).toBe("sw")
    expect(root.className).toContain("mine")
    root.querySelector("input")!.click()
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it("runs onClick once per press, wherever on the control the press lands", async () => {
    const onClick = vi.fn()
    const { container } = render(<Switch aria-label="Notify" onClick={onClick} />)

    await userEvent.click(input("Notify"))
    expect(onClick).toHaveBeenCalledTimes(1)
    await userEvent.click(container.querySelector(".switch__control")!)
    expect(onClick).toHaveBeenCalledTimes(2)
    await userEvent.click(container.querySelector('[data-slot="switch-content"]')!)
    expect(onClick).toHaveBeenCalledTimes(3)
    input("Notify").focus()
    await userEvent.keyboard(" ")
    expect(onClick).toHaveBeenCalledTimes(4)
  })

  it("toggles on Space and not on Enter, as a native checkbox does", async () => {
    const onCheckedChange = vi.fn()
    render(<Switch aria-label="Notify" onCheckedChange={onCheckedChange} />)
    input("Notify").focus()

    await userEvent.keyboard("{Enter}")
    expect(onCheckedChange).not.toHaveBeenCalled()
    await userEvent.keyboard(" ")
    expect(onCheckedChange).toHaveBeenCalledTimes(1)
  })

  it("puts a ref on the root div", () => {
    const ref = createRef<HTMLDivElement>()
    render(<Switch aria-label="Notify" ref={ref} />)
    expect(ref.current?.dataset.slot).toBe("switch")
  })

  it("accepts a bigger press target around the track", () => {
    render(<Switch aria-label="Notify" targetClassName="min-h-[40px]" />)
    expect(input("Notify").closest('[data-slot="switch-content"]')!.className).toContain("min-h-[40px]")
  })
})
