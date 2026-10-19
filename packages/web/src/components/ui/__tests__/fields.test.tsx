import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { Input } from "../input"
import { Textarea } from "../textarea"

describe.each([
  ["Input", (props: Record<string, unknown>) => <Input aria-label="Field" {...props} />, "input"],
  ["Textarea", (props: Record<string, unknown>) => <Textarea aria-label="Field" {...props} />, "textarea"],
] as const)("%s", (_name, renderField, base) => {
  const field = () => screen.getByLabelText("Field") as HTMLInputElement | HTMLTextAreaElement

  it("wears HeroUI's field classes on a native element", () => {
    render(renderField({ className: "mine" }))

    expect(field().className).toContain(base)
    expect(field().className).toContain(`${base}--primary`)
    expect(field().className).toContain("mine")
    expect(field().tagName.toLowerCase()).toBe(base)
  })

  it("takes typing and reports it through onChange", async () => {
    const onChange = vi.fn()
    render(renderField({ onChange }))

    await userEvent.type(field(), "hi")
    expect(field().value).toBe("hi")
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it("is reachable by the keyboard and focuses on a click", async () => {
    render(renderField({}))

    await userEvent.tab()
    expect(document.activeElement).toBe(field())
  })

  it("does not take typing or focus when disabled", async () => {
    render(renderField({ disabled: true }))

    await userEvent.type(field(), "x")
    expect(field().disabled).toBe(true)
    expect(field().value).toBe("")
    await userEvent.tab()
    expect(document.activeElement).not.toBe(field())
  })

  it("keeps placeholder, name, required and aria-invalid, which the invalid style reads", () => {
    render(renderField({ placeholder: "Type", name: "f", required: true, "aria-invalid": true }))

    expect(field().placeholder).toBe("Type")
    expect(field().name).toBe("f")
    expect(field().required).toBe(true)
    expect(field().getAttribute("aria-invalid")).toBe("true")
  })

  it("stays the same element when it is rendered again, so a caret is never lost", async () => {
    const { rerender } = render(renderField({ defaultValue: "" }))
    await userEvent.click(field())
    const before = field()

    rerender(renderField({ defaultValue: "", className: "other" }))
    expect(field()).toBe(before)
    expect(document.activeElement).toBe(before)
    fireEvent.change(before, { target: { value: "x" } })
  })
})

describe("Input", () => {
  it("keeps its type", () => {
    render(<Input aria-label="Field" type="password" />)
    expect((screen.getByLabelText("Field") as HTMLInputElement).type).toBe("password")
  })
})

describe("Textarea", () => {
  it("defaults to four rows and takes another count", () => {
    const { rerender } = render(<Textarea aria-label="Field" />)
    expect((screen.getByLabelText("Field") as HTMLTextAreaElement).rows).toBe(4)

    rerender(<Textarea aria-label="Field" rows={8} />)
    expect((screen.getByLabelText("Field") as HTMLTextAreaElement).rows).toBe(8)
  })
})
