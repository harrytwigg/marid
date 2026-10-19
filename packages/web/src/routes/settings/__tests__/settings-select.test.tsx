import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { SettingsSelect } from "../shared"

const options = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta", disabled: true },
  { value: "c", label: "Gamma" },
]

describe("SettingsSelect", () => {
  it("is a native select that reports the chosen value and marks a disabled option", () => {
    const onChange = vi.fn()
    render(<SettingsSelect value="a" onChange={onChange} options={options} ariaLabel="Letter" />)
    const select = screen.getByRole("combobox", { name: "Letter" }) as HTMLSelectElement

    expect(select.tagName).toBe("SELECT")
    expect((screen.getByRole("option", { name: "Beta" }) as HTMLOptionElement).disabled).toBe(true)
    fireEvent.change(select, { target: { value: "c" } })
    expect(onChange).toHaveBeenCalledWith("c")
  })

  it("keeps room for the chevron, which lets a press through to the select", () => {
    const { container } = render(<SettingsSelect value="a" onChange={() => {}} options={options} ariaLabel="Letter" />)

    expect(container.querySelector("select")?.className).toContain("pe-8")
    expect(container.querySelector(".select__indicator")?.getAttribute("class")).toContain("pointer-events-none")
  })
})
