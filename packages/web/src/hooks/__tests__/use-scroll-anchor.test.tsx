import { useRef } from "react"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useScrollAnchor } from "../use-scroll-anchor"

/** jsdom has no layout, so the list is given one: every row is ROW_H tall and
 *  its rect follows its position in the current DOM order minus scrollTop. */
const ROW_H = 60
const VIEWPORT_H = 600

function Scroller({ ids, enabled }: { ids: string[]; enabled: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const onScroll = useScrollAnchor(ref, enabled)
  return (
    <div ref={ref} data-testid="scroller" onScroll={onScroll}>
      {ids.map((id) => <div key={id} data-anchor-id={id} />)}
    </div>
  )
}

function installLayout() {
  const scroller = screen.getByTestId("scroller") as HTMLDivElement
  const rowIds = () =>
    Array.from(scroller.querySelectorAll<HTMLElement>("[data-anchor-id]")).map((row) => row.getAttribute("data-anchor-id") as string)
  const scrollHeight = () => rowIds().length * ROW_H
  let scrollTop = 0

  Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => VIEWPORT_H })
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => scrollHeight() })
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (next: number) => { scrollTop = Math.max(0, Math.min(next, Math.max(0, scrollHeight() - VIEWPORT_H))) },
  })

  const offsetOf = (id: string) => rowIds().indexOf(id) * ROW_H - scrollTop
  const rect = (top: number, height: number) => ({
    top, bottom: top + height, height, left: 0, right: 390, width: 390, x: 0, y: top, toJSON: () => ({}),
  })
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this === scroller) return rect(0, VIEWPORT_H) as DOMRect
    const id = this.getAttribute("data-anchor-id")
    if (!id || rowIds().indexOf(id) < 0) return rect(0, 0) as DOMRect
    return rect(offsetOf(id), ROW_H) as DOMRect
  })

  return {
    scroller,
    offsetOf,
    scrollTo: (top: number) => act(() => { scroller.scrollTop = top; fireEvent.scroll(scroller) }),
  }
}

function ids(from: number, count: number): string[] {
  return Array.from({ length: count }, (_, k) => `TSK-${from + k}`)
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe("useScrollAnchor", () => {
  it("holds the anchored row when rows appear above it", () => {
    const { rerender } = render(<Scroller ids={ids(10, 40)} enabled />)
    const layout = installLayout()
    layout.scrollTo(630)
    const before = layout.offsetOf("TSK-20")

    rerender(<Scroller ids={[...ids(1, 3), ...ids(10, 40)]} enabled />)

    expect(layout.offsetOf("TSK-20")).toBe(before)
    expect(layout.scroller.scrollTop).toBe(630 + 3 * ROW_H)
  })

  it("leaves a reader who scrolled between commits where they scrolled to", () => {
    // The correction is only ever against the last position the reader chose:
    // re-anchoring on scroll is what keeps a plain re-render from undoing it.
    const { rerender } = render(<Scroller ids={ids(10, 40)} enabled />)
    const layout = installLayout()
    layout.scrollTo(630)
    layout.scrollTo(900)

    rerender(<Scroller ids={ids(10, 40)} enabled />)

    expect(layout.scroller.scrollTop).toBe(900)
  })

  it("makes no correction while disabled, so a drag reorder is left alone", () => {
    const { rerender } = render(<Scroller ids={ids(10, 40)} enabled={false} />)
    const layout = installLayout()
    layout.scrollTo(630)

    rerender(<Scroller ids={[...ids(1, 3), ...ids(10, 40)]} enabled={false} />)

    expect(layout.scroller.scrollTop).toBe(630)
  })
})
