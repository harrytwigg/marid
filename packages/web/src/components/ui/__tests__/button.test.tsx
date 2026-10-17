import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createRef } from "react"
import { describe, expect, it, vi } from "vitest"
import { Button, buttonVariants } from "../button"

describe("Button", () => {
  it("is a native button drawn in HeroUI's variant and size classes", () => {
    render(<Button variant="destructive" size="lg">Delete</Button>)
    const button = screen.getByRole("button", { name: "Delete" })

    expect(button.tagName).toBe("BUTTON")
    expect(button.className).toContain("button--danger")
    expect(button.className).toContain("button--lg")
    expect(button.dataset.variant).toBe("destructive")
    expect(button.dataset.size).toBe("lg")
  })

  it.each([
    ["default", "button--primary"],
    ["destructive", "button--danger"],
    ["outline", "button--outline"],
    ["secondary", "button--secondary"],
    ["ghost", "button--ghost"],
    ["link", "button--ghost"],
  ] as const)("maps the %s variant to %s", (variant, expected) => {
    render(<Button variant={variant}>{variant}</Button>)
    expect(screen.getByRole("button", { name: variant }).className).toContain(expected)
  })

  it("keeps the app's sizes, including the two HeroUI has no name for", () => {
    render(
      <>
        <Button size="xs">xs</Button>
        <Button size="icon" aria-label="icon" />
        <Button size="icon-xs" aria-label="icon-xs" />
      </>,
    )
    expect(screen.getByRole("button", { name: "xs" }).className).toContain("h-6")
    expect(screen.getByRole("button", { name: "icon" }).className).toContain("button--icon-only")
    expect(screen.getByRole("button", { name: "icon-xs" }).className).toContain("size-6")
  })

  it("runs onClick from a click and from Enter and Space, with the DOM event", async () => {
    let target: EventTarget | null = null
    const onClick = vi.fn((event: React.MouseEvent) => {
      target = event.currentTarget
    })
    render(<Button onClick={onClick}>Save</Button>)
    const button = screen.getByRole("button", { name: "Save" })

    await userEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(target).toBe(button)

    button.focus()
    await userEvent.keyboard("{Enter}")
    await userEvent.keyboard(" ")
    expect(onClick).toHaveBeenCalledTimes(3)
  })

  it("is reached by Tab, which is what :focus-visible (HeroUI's ring) answers", async () => {
    render(<Button>Save</Button>)

    await userEvent.tab()
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Save" }))
  })

  it("does nothing when disabled, from the pointer or the keyboard", async () => {
    const onClick = vi.fn()
    render(<Button disabled onClick={onClick}>Save</Button>)
    const button = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement

    expect(button.disabled).toBe(true)
    await userEvent.click(button)
    button.focus()
    await userEvent.keyboard("{Enter}")
    expect(onClick).not.toHaveBeenCalled()
  })

  it("keeps the native default: a button submits its form unless told otherwise", () => {
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault())
    render(
      <form onSubmit={onSubmit}>
        <Button>Go</Button>
        <Button type="button">Stay</Button>
      </form>,
    )

    fireEvent.click(screen.getByRole("button", { name: "Stay" }))
    expect(onSubmit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Go" }))
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it("passes every prop a button takes straight to the element, pointer handlers included", () => {
    const ref = createRef<HTMLButtonElement>()
    const onMouseDown = vi.fn((event: React.MouseEvent) => event.preventDefault())
    const onPointerDown = vi.fn()
    render(
      <Button
        ref={ref}
        title="Saves"
        role="menuitem"
        tabIndex={-1}
        draggable
        data-testid="save"
        aria-label="Save it"
        className="extra"
        onMouseDown={onMouseDown}
        onPointerDown={onPointerDown}
      >
        x
      </Button>,
    )
    const button = screen.getByTestId("save")

    expect(ref.current).toBe(button)
    expect(button.getAttribute("title")).toBe("Saves")
    expect(button.getAttribute("role")).toBe("menuitem")
    expect(button.tabIndex).toBe(-1)
    expect(button.draggable).toBe(true)
    expect(button.getAttribute("aria-label")).toBe("Save it")
    expect(button.className).toContain("extra")

    // A button that keeps focus in a field by cancelling mousedown still can.
    const prevented = !fireEvent.mouseDown(button)
    fireEvent.pointerDown(button)
    expect(prevented).toBe(true)
    expect(onPointerDown).toHaveBeenCalledTimes(1)
  })

  it("lets asChild put the button's look on another element", () => {
    render(
      <Button asChild variant="outline">
        <a href="/x">Go</a>
      </Button>,
    )
    const link = screen.getByRole("link", { name: "Go" })

    expect(link.className).toContain("button--outline")
    expect(link.dataset.slot).toBe("button")
  })

  it("exposes the class list for non-React callers", () => {
    expect(buttonVariants({ variant: "secondary", size: "sm", className: "mine" })).toMatch(/button--secondary.*mine/)
  })
})
