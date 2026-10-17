import { execFileSync } from "node:child_process"
import path from "node:path"
import { render } from "@testing-library/react"
import { createElement } from "react"
import { describe, expect, it } from "vitest"

import * as icons from "@/components/ui/icon"
import { Check, Loader2, ICONS, Icon } from "@/components/ui/icon"

const packageRoot = path.resolve(__dirname, "../../../..")

describe("icons", () => {
  it("draws 24px, decorative, in currentColor by default", () => {
    const { container } = render(<Check />)
    const svg = container.querySelector("svg")
    expect(svg?.getAttribute("width")).toBe("24")
    expect(svg?.getAttribute("height")).toBe("24")
    expect(svg?.getAttribute("fill")).toBe("currentColor")
    expect(svg?.getAttribute("aria-hidden")).toBe("true")
    expect(svg?.getAttribute("data-icon")).toBe("Check")
  })

  it("is duotone: a 20% layer under the outline", () => {
    const { container } = render(<Check />)
    const paths = container.querySelectorAll("svg > path")
    expect(paths).toHaveLength(2)
    expect(paths[0]?.getAttribute("opacity")).toBe("0.2")
    expect(paths[1]?.hasAttribute("opacity")).toBe(false)
  })

  it("draws the carets in regular weight: one outline path, no fill layer", () => {
    for (const name of ["ChevronDown", "ChevronLeft", "ChevronRight", "ChevronUp", "ChevronRightIcon"] as const) {
      const Glyph = icons[name]
      const { container, unmount } = render(<Glyph />)
      expect(container.querySelector(`[data-icon="${name}"]`)).not.toBeNull()
      expect(container.querySelectorAll("svg > path")).toHaveLength(1)
      unmount()
    }
  })

  it("raises the layer to full strength when filled", () => {
    const { container } = render(<Check filled />)
    const paths = container.querySelectorAll("svg > path")
    expect(paths[0]?.getAttribute("opacity")).toBe("1")
    expect(container.querySelector("svg")?.hasAttribute("filled")).toBe(false)
  })

  it("takes size, color, className and SVG props", () => {
    const { container } = render(<Check size={12} color="red" className="x" data-testid="t" />)
    const svg = container.querySelector("svg")
    expect(svg?.getAttribute("width")).toBe("12")
    expect(svg?.getAttribute("fill")).toBe("red")
    expect(svg?.getAttribute("class")).toBe("x")
    expect(svg?.getAttribute("data-testid")).toBe("t")
  })

  it("is announced when the caller labels it", () => {
    const { container } = render(<Check aria-label="Done" />)
    const svg = container.querySelector("svg")
    expect(svg?.hasAttribute("aria-hidden")).toBe(false)
    expect(svg?.getAttribute("aria-label")).toBe("Done")
  })

  it("keeps a spinner spinning through its class", () => {
    const { container } = render(<Loader2 className="animate-spin" />)
    expect(container.querySelector('[data-icon="Loader2"]')?.classList.contains("animate-spin")).toBe(true)
  })

  it("names each icon module after the export", () => {
    for (const [name, Glyph] of Object.entries(icons)) {
      if (name === "Icon" || name === "ICONS" || name === "lookupIcon") continue
      const { container } = render(createElement(Glyph as icons.IconComponent))
      expect(container.querySelector("svg")?.getAttribute("data-icon")).toBe(name)
    }
  })

  it("serves the plugin icon set from the same glyphs", () => {
    const { container } = render(<Icon name="check" />)
    expect(container.querySelector("svg")?.getAttribute("data-icon")).toBe("Check")
    expect(container.querySelector("svg")?.getAttribute("width")).toBe("16")
    expect(Object.values(ICONS).every((glyph) => typeof glyph === "function")).toBe(true)
  })

  it("matches what the generator would write", () => {
    expect(() =>
      execFileSync(process.execPath, ["scripts/generate-icons.mjs", "--check"], { cwd: packageRoot, stdio: "pipe" }),
    ).not.toThrow()
  })
})
