import { readFileSync } from "node:fs"
import path from "node:path"

import * as React from "react"
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { ScrollArea } from "../scroll-area"

const GLOBALS = readFileSync(path.resolve(__dirname, "../../../routes/globals.css"), "utf8")

describe("ScrollArea", () => {
  it("is one scrolling element holding its children, with the caller's div props", () => {
    const ref = React.createRef<HTMLDivElement>()
    render(
      <ScrollArea ref={ref} data-testid="area" aria-label="Results" className="h-40">
        <p>one</p>
        <p>two</p>
      </ScrollArea>,
    )

    const area = screen.getByTestId("area")
    expect(ref.current).toBe(area)
    expect(area.getAttribute("data-slot")).toBe("scroll-area")
    expect(area.getAttribute("aria-label")).toBe("Results")
    expect(area.classList.contains("scroll-area")).toBe(true)
    expect(area.classList.contains("overflow-auto")).toBe(true)
    expect(area.classList.contains("h-40")).toBe(true)
    expect(Array.from(area.children).map((child) => child.textContent)).toEqual(["one", "two"])
  })

  it("lets a caller's overflow utility replace the default", () => {
    render(<ScrollArea data-testid="area" className="overflow-hidden" />)

    const classes = screen.getByTestId("area").className.split(" ")
    expect(classes).toContain("overflow-hidden")
    expect(classes).not.toContain("overflow-auto")
  })
})

describe("the scroll-area bar", () => {
  const rule = (selector: string) => {
    const start = GLOBALS.indexOf(selector)
    expect(start, `${selector} is not in globals.css`).toBeGreaterThan(-1)
    return GLOBALS.slice(start, GLOBALS.indexOf("}", start))
  }

  it("rests invisible and is drawn while the pointer or focus is inside, in the standard properties", () => {
    expect(rule(".scroll-area {")).toMatch(/scrollbar-width:\s*thin/)
    expect(rule(".scroll-area {")).toMatch(/scrollbar-color:\s*transparent transparent/)
    expect(rule(".scroll-area:is(:hover, :focus-within) {")).toMatch(/scrollbar-color:\s*var\(--fill-primary\) transparent/)
  })

  it("is drawn the same way for WebKit's pseudo-elements", () => {
    expect(rule(".scroll-area::-webkit-scrollbar {")).toMatch(/width:\s*10px/)
    expect(rule(".scroll-area::-webkit-scrollbar-thumb {")).toMatch(/background-color:\s*transparent/)
    expect(rule(".scroll-area:is(:hover, :focus-within)::-webkit-scrollbar-thumb {")).toMatch(/var\(--fill-primary\)/)
  })
})
