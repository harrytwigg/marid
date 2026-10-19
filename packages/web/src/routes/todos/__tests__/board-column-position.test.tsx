import { act, render, screen } from "@testing-library/react"
import { useRef } from "react"
import { describe, expect, it } from "vitest"
import { SNAP_ATTRIBUTE, useColumnPosition } from "../board/phone-board"

/* Which column the phone's strip is parked on. jsdom has no layout, so the strip's and the
 * columns' rectangles, and its scroll metrics, are stubbed. */

const rect = (left: number) => ({ left, right: left + 100, top: 0, bottom: 10, width: 100, height: 10, x: left, y: 0, toJSON: () => ({}) }) as DOMRect

function Strip({ lefts, watch = "a", active = true }: { lefts: number[]; watch?: string; active?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const { index, total } = useColumnPosition(ref, active, watch)
  return (
    <div>
      <div ref={ref} data-testid="strip">
        {lefts.map((left, i) => (
          <section key={i} {...{ [SNAP_ATTRIBUTE]: "" }} ref={(el) => void (el && (el.getBoundingClientRect = () => rect(left)))} />
        ))}
      </div>
      <output data-testid="position">{`${index}/${total}`}</output>
    </div>
  )
}

function stubStrip(strip: HTMLElement, { scrollLeft, clientWidth, scrollWidth }: { scrollLeft: number; clientWidth: number; scrollWidth: number }) {
  strip.getBoundingClientRect = () => rect(0)
  Object.defineProperty(strip, "scrollLeft", { configurable: true, value: scrollLeft })
  Object.defineProperty(strip, "clientWidth", { configurable: true, value: clientWidth })
  Object.defineProperty(strip, "scrollWidth", { configurable: true, value: scrollWidth })
}

const frame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))

describe("useColumnPosition", () => {
  it("names the column whose left edge is nearest the strip's", async () => {
    // The strip is scrolled so the second column starts 4px from the left edge.
    const view = render(<Strip lefts={[-296, 4, 304]} />)
    stubStrip(screen.getByTestId("strip"), { scrollLeft: 300, clientWidth: 390, scrollWidth: 800 })
    view.rerender(<Strip lefts={[-296, 4, 304]} watch="b" />)
    expect(screen.getByTestId("position").textContent).toBe("2/3")
  })

  it("follows a scroll", async () => {
    render(<Strip lefts={[0, 300, 600]} />)
    const strip = screen.getByTestId("strip")
    stubStrip(strip, { scrollLeft: 0, clientWidth: 390, scrollWidth: 900 })
    strip.dispatchEvent(new Event("scroll"))
    await frame()
    expect(screen.getByTestId("position").textContent).toBe("1/3")

    stubStrip(strip, { scrollLeft: 300, clientWidth: 390, scrollWidth: 900 })
    for (const [i, column] of strip.querySelectorAll<HTMLElement>("section").entries()) column.getBoundingClientRect = () => rect(i * 300 - 300)
    strip.dispatchEvent(new Event("scroll"))
    await frame()
    expect(screen.getByTestId("position").textContent).toBe("2/3")
  })

  it("reads the last column once the strip is scrolled to its end, which it cannot align to the start", async () => {
    render(<Strip lefts={[-410, -110, 190]} />)
    const strip = screen.getByTestId("strip")
    stubStrip(strip, { scrollLeft: 410, clientWidth: 390, scrollWidth: 800 })
    strip.dispatchEvent(new Event("scroll"))
    await frame()
    expect(screen.getByTestId("position").textContent).toBe("3/3")
  })

  it("reads nothing while the strip is hidden", () => {
    render(<Strip lefts={[0, 300]} active={false} />)
    expect(screen.getByTestId("position").textContent).toBe("0/0")
  })
})
