import { act, fireEvent, render, screen } from "@testing-library/react"
import { createRef } from "react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Button, buttonVariants } from "../button"
import { preloadHeroUI, resetHeroUIForTests } from "../heroui-lazy"

afterEach(async () => {
  await preloadHeroUI()
})

describe("Button", () => {
  it("is a React Aria button drawn in HeroUI's variant and size classes", () => {
    render(<Button variant="destructive" size="lg">Delete</Button>)
    const button = screen.getByRole("button", { name: "Delete" })

    expect(button.hasAttribute("data-rac")).toBe(true)
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

  it("passes onClick the DOM event once per click, and a keyboard press clicks too", async () => {
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

  it("marks keyboard focus as focus-visible, which is what draws the ring, and pointer focus as not", async () => {
    render(<Button>Save</Button>)
    const button = screen.getByRole("button", { name: "Save" })

    await userEvent.tab()
    expect(document.activeElement).toBe(button)
    expect(button.getAttribute("data-focus-visible")).toBe("true")

    await userEvent.tab()
    await userEvent.click(button)
    expect(button.getAttribute("data-focus-visible")).toBeNull()
  })

  it("marks a press with data-pressed while it is held, and clears it on release", async () => {
    render(<Button>Save</Button>)
    const button = screen.getByRole("button", { name: "Save" })

    await userEvent.pointer({ keys: "[MouseLeft>]", target: button })
    expect(button.getAttribute("data-pressed")).toBe("true")
    fireEvent.mouseUp(document.body)
    fireEvent.pointerUp(document.body, { pointerType: "mouse", button: 0 })
    await userEvent.click(button)
    expect(button.getAttribute("data-pressed")).toBeNull()
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

  it("keeps the native defaults: a button submits its form unless told otherwise", () => {
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

  it("forwards the props a button carries, including the ones React Aria drops", () => {
    const ref = createRef<HTMLButtonElement>()
    render(
      <Button ref={ref} title="Saves" role="menuitem" tabIndex={-1} data-testid="save" aria-label="Save it" className="extra">
        x
      </Button>,
    )
    const button = screen.getByTestId("save")

    expect(ref.current).toBe(button)
    expect(button.getAttribute("title")).toBe("Saves")
    expect(button.getAttribute("role")).toBe("menuitem")
    expect(button.tabIndex).toBe(-1)
    expect(button.getAttribute("aria-label")).toBe("Save it")
    expect(button.className).toContain("extra")
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

describe("Button before React Aria has loaded", () => {
  it("draws a plain button that looks and works the same, then swaps in place", async () => {
    resetHeroUIForTests()
    const onClick = vi.fn()
    render(<Button variant="secondary" onClick={onClick}>Save</Button>)
    const plain = screen.getByRole("button", { name: "Save" })

    expect(plain.hasAttribute("data-rac")).toBe(false)
    expect(plain.className).toContain("button--secondary")
    fireEvent.click(plain)
    expect(onClick).toHaveBeenCalledTimes(1)

    await act(async () => {
      await preloadHeroUI()
    })
    const loaded = screen.getByRole("button", { name: "Save" })
    expect(loaded.hasAttribute("data-rac")).toBe(true)
    expect(loaded.className).toContain("button--secondary")
    fireEvent.click(loaded)
    expect(onClick).toHaveBeenCalledTimes(2)
  })
})
