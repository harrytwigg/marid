import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { ToggleSwitch } from "../toggle-switch"

describe("ToggleSwitch", () => {
  it("is named, reports the next value, and shows the current one as checked", async () => {
    const onChange = vi.fn()
    render(<ToggleSwitch checked label="Enabled" onChange={onChange} />)
    const control = screen.getByRole("switch", { name: "Enabled" }) as HTMLInputElement

    expect(control.checked).toBe(true)
    await userEvent.click(control)
    expect(onChange).toHaveBeenCalledWith(false)
  })

  // The track is 24px; the press must land on a bigger box than that.
  it("receives the press on a box at least 40px tall on a phone, 34px from md, and 44px wide", () => {
    render(<ToggleSwitch checked={false} label="Enabled" onChange={() => {}} />)
    const target = screen.getByRole("switch", { name: "Enabled" }).closest('[data-slot="switch-content"]')!

    expect(target.className).toContain("min-h-[40px]")
    expect(target.className).toContain("md:min-h-[34px]")
    expect(target.className).toContain("min-w-[44px]")
    expect(target.querySelector(".switch__control")).not.toBeNull()
  })

  it("does not toggle while disabled", async () => {
    const onChange = vi.fn()
    render(<ToggleSwitch checked={false} disabled label="Enabled" onChange={onChange} />)
    const control = screen.getByRole("switch", { name: "Enabled" }) as HTMLInputElement

    expect(control.disabled).toBe(true)
    await userEvent.click(control)
    control.focus()
    await userEvent.keyboard(" ")
    expect(onChange).not.toHaveBeenCalled()
  })

  it("keeps a click from reaching a clickable row around it, when asked to", () => {
    const onRow = vi.fn()
    render(
      <div onClick={onRow}>
        <ToggleSwitch checked={false} label="Enabled" onChange={() => {}} onClick={(event) => event.stopPropagation()} />
      </div>,
    )

    fireEvent.click(screen.getByRole("switch", { name: "Enabled" }))
    expect(onRow).not.toHaveBeenCalled()
  })
})
