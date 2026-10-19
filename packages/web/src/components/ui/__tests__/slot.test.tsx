import * as React from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { Slot } from "../slot"

describe("Slot", () => {
  it("draws its child, with the slot's props on it", () => {
    render(
      <Slot data-testid="target" aria-label="from the slot">
        <a href="/somewhere">go</a>
      </Slot>,
    )

    const link = screen.getByTestId("target")
    expect(link.tagName).toBe("A")
    expect(link.getAttribute("href")).toBe("/somewhere")
    expect(link.getAttribute("aria-label")).toBe("from the slot")
    expect(document.querySelectorAll("a")).toHaveLength(1)
  })

  it("joins class names, slot first", () => {
    render(
      <Slot className="from-slot">
        <span data-testid="target" className="from-child">x</span>
      </Slot>,
    )

    expect(screen.getByTestId("target").className).toBe("from-slot from-child")
  })

  it("keeps a slot class name when the child has none", () => {
    render(
      <Slot className="from-slot">
        <span data-testid="target">x</span>
      </Slot>,
    )

    expect(screen.getByTestId("target").className).toBe("from-slot")
  })

  it("merges styles, the child's declarations winning", () => {
    render(
      <Slot style={{ color: "red", marginTop: 4 }}>
        <span data-testid="target" style={{ color: "blue", paddingTop: 2 }}>x</span>
      </Slot>,
    )

    const style = screen.getByTestId("target").style
    expect(style.color).toBe("blue")
    expect(style.marginTop).toBe("4px")
    expect(style.paddingTop).toBe("2px")
  })

  it("runs the child's handler first, then the slot's, and returns the child's result", async () => {
    const calls: string[] = []
    const onClick = vi.fn(() => { calls.push("slot") })
    render(
      <Slot onClick={onClick}>
        <button type="button" onClick={() => calls.push("child")}>press</button>
      </Slot>,
    )

    await userEvent.click(screen.getByRole("button", { name: "press" }))

    expect(calls).toEqual(["child", "slot"])
  })

  it("returns the child's result when both sides have the handler", () => {
    let merged: (() => string) | undefined
    function Child(props: { onSelect?: () => string }) {
      merged = props.onSelect
      return null
    }
    render(
      <Slot {...{ onSelect: () => "slot" }}>
        <Child onSelect={() => "child"} />
      </Slot>,
    )

    expect(merged?.()).toBe("child")
  })

  it("uses a handler that only the slot has", async () => {
    const onClick = vi.fn()
    render(
      <Slot onClick={onClick}>
        <button type="button">press</button>
      </Slot>,
    )

    await userEvent.click(screen.getByRole("button", { name: "press" }))

    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it("lets a prop the child sets win over the slot's", () => {
    render(
      <Slot data-testid="from-slot" title="slot title" id="slot-id">
        <span data-testid="from-child" title="child title">x</span>
      </Slot>,
    )

    const node = screen.getByTestId("from-child")
    expect(node.title).toBe("child title")
    expect(node.id).toBe("slot-id")
  })

  it("fills the slot's ref and the child's ref with the same element", () => {
    const slotRef = React.createRef<HTMLElement>()
    const childRef = React.createRef<HTMLButtonElement>()
    render(
      <Slot ref={slotRef}>
        <button type="button" ref={childRef}>x</button>
      </Slot>,
    )

    const button = screen.getByRole("button")
    expect(slotRef.current).toBe(button)
    expect(childRef.current).toBe(button)
  })

  it("calls a callback ref with the element and with null when it unmounts", () => {
    const slotRef = vi.fn()
    const childRef = React.createRef<HTMLButtonElement>()
    const { unmount } = render(
      <Slot ref={slotRef}>
        <button type="button" ref={childRef}>x</button>
      </Slot>,
    )
    const button = screen.getByRole("button")
    expect(slotRef).toHaveBeenLastCalledWith(button)

    unmount()

    expect(childRef.current).toBeNull()
    expect(slotRef).toHaveBeenLastCalledWith(null)
  })

  it("uses the slot's ref when the child has none", () => {
    const slotRef = React.createRef<HTMLElement>()
    render(
      <Slot ref={slotRef}>
        <span data-testid="target">x</span>
      </Slot>,
    )

    expect(slotRef.current).toBe(screen.getByTestId("target"))
  })

  it("draws nothing for a child that is not an element", () => {
    const { container } = render(<Slot>just text</Slot>)

    expect(container.innerHTML).toBe("")
  })

  it("refuses more than one child", () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined)
    expect(() =>
      render(
        <Slot>
          <span>one</span>
          <span>two</span>
        </Slot>,
      ),
    ).toThrow()
    quiet.mockRestore()
  })
})
