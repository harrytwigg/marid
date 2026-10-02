import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { UNDO_WINDOW_MS, forgetUndo, offerUndo } from "../talk-undo-store"
import { UndoStrip } from "../undo-strip"

const COMMENTED = "Commented on AAA-1"

const strip = () => document.querySelector<HTMLElement>("[data-talk-undo-strip]")
const undoButton = () => screen.getByRole("button", { name: /Undo/ })

function stubReducedMotion(reduce: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduce && query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }))
}

/** The strip is driven by the store, so an offer has to be made after mounting. */
function offer(performed: string, reverse: () => Promise<void>) {
  act(() => {
    offerUndo(performed, reverse)
  })
}

beforeEach(() => {
  localStorage.clear()
  stubReducedMotion(false)
})

afterEach(() => {
  act(() => forgetUndo())
})

describe("the undo strip", () => {
  it("stays off screen until a write has something to take back", () => {
    render(<UndoStrip />)

    expect(strip()).toBeNull()
  })

  it("says what happened, and takes it back on a click", async () => {
    const reverse = vi.fn(async () => {})
    render(<UndoStrip />)

    offer(COMMENTED, reverse)
    expect(screen.getByText(COMMENTED)).toBeTruthy()

    await userEvent.click(screen.getByRole("button", { name: /Undo/ }))

    expect(reverse).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(strip()).toBeNull())
  })

  it("sits above the mobile tab bar rather than over its tap targets", () => {
    render(<UndoStrip />)

    offer(COMMENTED, vi.fn(async () => {}))

    // jsdom runs no cascade, so the class is the only handle on the offset. The
    // strip takes pointer events: sitting on the bar would swallow taps meant
    // for Chat or Todos.
    expect(strip()!.className).toContain("bottom-[calc(49px+max(var(--safe-bottom),6px)+var(--space-3))]")
    expect(strip()!.className).toContain("lg:bottom-[calc(var(--space-3)+var(--safe-bottom))]")
  })
})

describe("the countdown", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))
  afterEach(() => vi.useRealTimers())

  it("shows the whole seconds left, and ticks them down", () => {
    render(<UndoStrip />)
    offer(COMMENTED, vi.fn(async () => {}))

    expect(undoButton().textContent).toContain(String(UNDO_WINDOW_MS / 1000))

    act(() => {
      vi.advanceTimersByTime(2_000)
    })
    expect(undoButton().textContent).toContain("13")
  })
})

describe("reduced motion", () => {
  it("drops the entrance animation entirely when the operator asked for less motion", () => {
    stubReducedMotion(true)
    render(<UndoStrip />)

    offer(COMMENTED, vi.fn(async () => {}))

    expect(strip()!.style.animation).toBe("")
  })

  it("plays the entrance when motion is allowed", () => {
    render(<UndoStrip />)

    offer(COMMENTED, vi.fn(async () => {}))

    expect(strip()!.style.animation).toContain("jinn-undo-rise")
  })
})

describe("a reversal that fails", () => {
  it("shows why the change is still there, and gets out of the way when dismissed", async () => {
    render(<UndoStrip />)
    offer(COMMENTED, async () => {
      throw new Error("the gateway refused")
    })

    await userEvent.click(undoButton())

    const failure = await screen.findByText(/the gateway refused/)
    expect(failure.textContent).toContain("The change is still in place.")
    // jsdom runs no cascade, so the class is the only handle on it: the
    // gateway's reason is the whole account of what went wrong, and at 390px a
    // truncated line shows none of it.
    expect(failure.className).not.toContain("truncate")
    expect(screen.queryByRole("button", { name: /Undo/ })).toBeNull()

    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }))

    expect(strip()).toBeNull()
  })
})
