import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type * as React from "react"
import { describe, expect, it, vi } from "vitest"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../tooltip"

function Example(props: { onOpenChange?: (open: boolean) => void; delayDuration?: number }) {
  return (
    <Tooltip {...props}>
      <TooltipTrigger asChild>
        <button type="button">Archive</button>
      </TooltipTrigger>
      <TooltipContent>Move to the archive</TooltipContent>
    </Tooltip>
  )
}

/** React Aria counts a hover only once it has seen a pointer move or press, and
 *  `userEvent.hover` moves it only after the enter that opens the tooltip. A
 *  real browser needs no help: the captures drive an actual hover. */
async function hover(element: Element) {
  fireEvent.pointerDown(document.body)
  fireEvent.pointerUp(document.body)
  await userEvent.hover(element)
}

const pause = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)) })

describe("Tooltip", () => {
  it("is a tooltip the trigger is described by while it is open, and by nothing otherwise", async () => {
    render(<Example delayDuration={0} />)
    const trigger = screen.getByRole("button", { name: "Archive" })
    expect(trigger.hasAttribute("aria-describedby")).toBe(false)
    expect(screen.queryByRole("tooltip")).toBeNull()

    await hover(trigger)

    const tip = await screen.findByRole("tooltip")
    expect(tip.textContent).toBe("Move to the archive")
    expect(trigger.getAttribute("aria-describedby")).toBe(tip.id)
    expect(trigger.getAttribute("aria-describedby")).toBeTruthy()
  })

  it("leaves the trigger as the one element it was: no wrapper takes the button role", () => {
    const { container } = render(<Example />)

    expect(container.querySelectorAll("button")).toHaveLength(1)
    expect(container.querySelector('[role="button"]')).toBeNull()
    expect(screen.getByRole("button", { name: "Archive" }).getAttribute("data-slot")).toBe("tooltip-trigger")
  })

  it("renders a button of its own without asChild", () => {
    render(
      <Tooltip>
        <TooltipTrigger>Info</TooltipTrigger>
        <TooltipContent>More</TooltipContent>
      </Tooltip>,
    )
    const trigger = screen.getByRole("button", { name: "Info" })

    expect(trigger.tagName).toBe("BUTTON")
    expect(trigger.getAttribute("type")).toBe("button")
  })

  it("opens when the keyboard focuses the trigger, and closes on Escape", async () => {
    const onOpenChange = vi.fn()
    render(<Example delayDuration={0} onOpenChange={onOpenChange} />)

    await userEvent.tab()
    expect(screen.getByRole("button", { name: "Archive" })).toBe(document.activeElement)
    await screen.findByRole("tooltip")
    expect(onOpenChange).toHaveBeenLastCalledWith(true)

    await userEvent.keyboard("{Escape}")

    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull())
    expect(onOpenChange).toHaveBeenLastCalledWith(false)
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Archive" }))
  })

  it("closes when focus leaves the trigger", async () => {
    render(
      <>
        <Example delayDuration={0} />
        <button type="button">Elsewhere</button>
      </>,
    )
    await userEvent.tab()
    await screen.findByRole("tooltip")

    await userEvent.tab()

    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull())
  })

  it("waits 300ms to open by default, and the provider's delay replaces that", async () => {
    // A tooltip opened a moment ago leaves the next one opening at once, as moving along a
    // toolbar should; let that window (500ms) pass before each timing.
    await pause(600)
    const first = render(<Example />)
    await hover(screen.getByRole("button", { name: "Archive" }))
    await pause(150)
    expect(screen.queryByRole("tooltip")).toBeNull()
    await screen.findByRole("tooltip")
    // Close it properly: React Aria's warm-up window is module state that starts counting down
    // when a tooltip closes, not when one unmounts.
    await userEvent.unhover(screen.getByRole("button", { name: "Archive" }))
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull())
    first.unmount()

    // Still shut at 500ms is not the 300ms default's doing: it is the provider's.
    await pause(600)
    render(
      <TooltipProvider delayDuration={800}>
        <Example />
      </TooltipProvider>,
    )
    await hover(screen.getByRole("button", { name: "Archive" }))
    await pause(500)
    expect(screen.queryByRole("tooltip")).toBeNull()
    await screen.findByRole("tooltip")
  })

  it("closes at once when the pointer leaves, as it always has", async () => {
    render(<Example delayDuration={0} />)
    const trigger = screen.getByRole("button", { name: "Archive" })
    await hover(trigger)
    await screen.findByRole("tooltip")

    await userEvent.unhover(trigger)

    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull(), { timeout: 200 })
  })

  describe("content props, which the SDK types as every div prop", () => {
    function WithProps({ content }: { content: Partial<React.ComponentProps<typeof TooltipContent>> }) {
      return (
        <Tooltip defaultOpen>
          <TooltipTrigger asChild>
            <button type="button">Archive</button>
          </TooltipTrigger>
          <TooltipContent {...content}>Move to the archive</TooltipContent>
        </Tooltip>
      )
    }

    it("forwards style (under React Aria's own positioning), title, aria-* and data-* onto the tooltip", async () => {
      render(
        <WithProps
          content={{
            style: { color: "red", maxWidth: 120 },
            title: "More",
            "aria-label": "Archive hint",
            "aria-live": "polite",
            "data-hint": "archive",
            id: "archive-hint",
          } as never}
        />,
      )

      const tip = await screen.findByRole("tooltip")
      expect(tip.style.color).toBe("red")
      expect(tip.style.maxWidth).toBe("120px")
      expect(tip.style.position).toBe("absolute")
      expect(tip.getAttribute("title")).toBe("More")
      expect(tip.getAttribute("aria-label")).toBe("Archive hint")
      expect(tip.getAttribute("aria-live")).toBe("polite")
      expect(tip.getAttribute("data-hint")).toBe("archive")
      expect(tip.id).toBe("archive-hint")
    })

    it("takes a hand-set attribute off again when the prop goes", async () => {
      const { rerender } = render(<WithProps content={{ title: "More" }} />)
      const tip = await screen.findByRole("tooltip")
      expect(tip.getAttribute("title")).toBe("More")

      rerender(<WithProps content={{}} />)

      expect(tip.hasAttribute("title")).toBe(false)
    })

    it("keeps its own role, and leaves the key and focus handlers to React Aria", async () => {
      const onKeyDown = vi.fn()
      const onFocus = vi.fn()
      render(<WithProps content={{ role: "note", onKeyDown, onFocus } as never} />)

      const tip = await screen.findByRole("tooltip")
      fireEvent.keyDown(tip, { key: "a" })
      fireEvent.focus(tip)

      expect(tip.getAttribute("role")).toBe("tooltip")
      expect(onKeyDown).not.toHaveBeenCalled()
      expect(onFocus).not.toHaveBeenCalled()
    })
  })

  it("draws on the overlay glass and HeroUI's tooltip classes", async () => {
    render(<Example delayDuration={0} />)
    await hover(screen.getByRole("button", { name: "Archive" }))

    const tip = await screen.findByRole("tooltip")
    expect(tip.classList.contains("tooltip")).toBe(true)
    expect(tip.classList.contains("glass-overlay")).toBe(true)
  })
})
