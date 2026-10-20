import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../hover-card"

function Example(props: { onOpenChange?: (open: boolean) => void; openDelay?: number; closeDelay?: number }) {
  return (
    <>
      <HoverCard openDelay={40} closeDelay={40} {...props}>
        <HoverCardTrigger asChild>
          <a href="#todo">ISS-1</a>
        </HoverCardTrigger>
        <HoverCardContent>The card</HoverCardContent>
      </HoverCard>
      <button type="button">Elsewhere</button>
    </>
  )
}

const pause = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)) })
const link = () => screen.getByRole("link", { name: "ISS-1" })
const card = () => screen.queryByRole("tooltip")

describe("HoverCard", () => {
  it("opens after its delay on pointer-enter, and closes after its delay on pointer-leave", async () => {
    render(<Example openDelay={80} closeDelay={80} />)

    fireEvent.pointerEnter(link(), { pointerType: "mouse" })
    await pause(30)
    expect(card()).toBeNull()
    await screen.findByRole("tooltip")
    expect(card()!.textContent).toBe("The card")

    fireEvent.pointerLeave(link(), { pointerType: "mouse" })
    await pause(30)
    expect(card()).not.toBeNull()
    await waitFor(() => expect(card()).toBeNull())
  })

  it("never opens for a touch pointer", async () => {
    render(<Example />)

    fireEvent.pointerEnter(link(), { pointerType: "touch" })
    await pause(120)

    expect(card()).toBeNull()
  })

  it("opens when the keyboard reaches the trigger, and closes when focus leaves it", async () => {
    render(<Example />)

    await userEvent.tab()
    expect(document.activeElement).toBe(link())
    await screen.findByRole("tooltip")

    await userEvent.tab()
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Elsewhere" }))
    await waitFor(() => expect(card()).toBeNull())
  })

  it("describes the trigger while it is open, and by nothing otherwise", async () => {
    render(<Example />)
    expect(link().hasAttribute("aria-describedby")).toBe(false)

    await userEvent.tab()
    const open = await screen.findByRole("tooltip")

    expect(open.id).toBeTruthy()
    expect(link().getAttribute("aria-describedby")).toBe(open.id)
    // The dismiss button React Aria adds is not part of what describes the link.
    expect(open.querySelector("button")).toBeNull()
  })

  it("closes on Escape wherever focus is, and stays shut until the pointer comes back", async () => {
    const onOpenChange = vi.fn()
    render(<Example onOpenChange={onOpenChange} />)
    fireEvent.pointerEnter(link(), { pointerType: "mouse" })
    await screen.findByRole("tooltip")
    // The pointer opened it, so focus is nowhere near the trigger.
    expect(document.activeElement).toBe(document.body)

    await userEvent.keyboard("{Escape}")

    await waitFor(() => expect(card()).toBeNull())
    expect(onOpenChange).toHaveBeenLastCalledWith(false)
    // Still over the link: a pointer that has not left does not reopen it.
    fireEvent.pointerEnter(link(), { pointerType: "mouse" })
    await pause(120)
    expect(card()).toBeNull()

    fireEvent.pointerLeave(link(), { pointerType: "mouse" })
    fireEvent.pointerEnter(link(), { pointerType: "mouse" })
    await screen.findByRole("tooltip")
  })

  it("closes when something scrolls under it, which is not a dismissal: focus or the pointer can open it again", async () => {
    render(<Example />)
    fireEvent.pointerEnter(link(), { pointerType: "mouse" })
    await screen.findByRole("tooltip")

    fireEvent.scroll(document)

    await waitFor(() => expect(card()).toBeNull())
    // Only Escape holds it shut until the pointer has left; a scroll does not.
    fireEvent.focus(link())
    await screen.findByRole("tooltip")
  })

  it("stays open while the pointer is on the card, so the gap can be crossed", async () => {
    render(<Example openDelay={10} closeDelay={80} />)
    fireEvent.pointerEnter(link(), { pointerType: "mouse" })
    await screen.findByRole("tooltip")

    fireEvent.pointerLeave(link(), { pointerType: "mouse" })
    await pause(20)
    fireEvent.pointerEnter(card()!.parentElement!, { pointerType: "mouse" })
    await pause(150)

    expect(card()).not.toBeNull()
  })

  it("is controlled by `open` and reports what it would do through `onOpenChange`", async () => {
    const onOpenChange = vi.fn()
    render(
      <HoverCard open={false} onOpenChange={onOpenChange} openDelay={10}>
        <HoverCardTrigger asChild>
          <a href="#todo">ISS-1</a>
        </HoverCardTrigger>
        <HoverCardContent>The card</HoverCardContent>
      </HoverCard>,
    )

    fireEvent.pointerEnter(link(), { pointerType: "mouse" })
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(true))

    expect(card()).toBeNull()
  })

  it("is not modal: the page stays reachable and nothing inside is focusable", async () => {
    render(<Example />)
    await userEvent.tab()
    await screen.findByRole("tooltip")

    expect(screen.getByRole("button", { name: "Elsewhere" }).closest("[aria-hidden]")).toBeNull()
    const tabbable = [...document.querySelectorAll<HTMLElement>("[data-slot=hover-card-content] *")].filter((element) => element.tabIndex >= 0)
    expect(tabbable).toHaveLength(0)
  })

  it("draws on the overlay glass and HeroUI's popover classes, above the app's own layers", async () => {
    render(<Example />)
    await userEvent.tab()

    await screen.findByRole("tooltip")
    const surface = document.querySelector<HTMLElement>("[data-slot=hover-card-content]")!
    expect(surface.classList.contains("popover")).toBe(true)
    expect(surface.classList.contains("glass-overlay")).toBe(true)
    expect(surface.style.zIndex).toBe("100000")
  })
})
