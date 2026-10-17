import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { BRAND_FAVICON_PNG, BRAND_FAVICON_SVG, BRAND_MARK_SRC } from "@/lib/brand"
import { BrandMark, PortalMark } from "../brand-mark"
import { BrandFavicon } from "../brand-favicon"
import { NavRibbon } from "../pill-nav"

const settings = { portalEmoji: null as string | null, portalIcon: null as string | null, portalName: null as string | null }

vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings }) }))
vi.mock("@/lib/route-prefetch", () => ({ prefetchRoute: vi.fn() }))

const markImages = (root: ParentNode) => root.querySelectorAll(`img[src="${BRAND_MARK_SRC}"]`)

beforeEach(() => {
  settings.portalEmoji = null
  settings.portalIcon = null
})

describe("PortalMark", () => {
  it("draws the glass mark by default", () => {
    const { container } = render(<PortalMark size={32} glyphClassName="glyph" />)
    expect(markImages(container)).toHaveLength(1)
    expect(container.querySelector(".glyph")).toBeNull()
  })

  it("draws the operator's emoji instead of the mark", () => {
    settings.portalEmoji = "🦊"
    const { container } = render(<PortalMark size={32} glyphClassName="glyph" />)
    expect(container.querySelector(".glyph")?.textContent).toBe("🦊")
    expect(markImages(container)).toHaveLength(0)
  })

  it("draws the operator's icon when no emoji is set, and the emoji when both are", () => {
    settings.portalIcon = "★"
    const first = render(<PortalMark size={32} glyphClassName="glyph" />)
    expect(first.container.querySelector(".glyph")?.textContent).toBe("★")
    first.unmount()

    settings.portalEmoji = "🦊"
    const second = render(<PortalMark size={32} glyphClassName="glyph" />)
    expect(second.container.querySelector(".glyph")?.textContent).toBe("🦊")
  })

  it("keeps the decorative mark out of the accessibility tree", () => {
    const { container } = render(<BrandMark size={72} />)
    const img = markImages(container)[0]
    expect(img.getAttribute("alt")).toBe("")
    expect(img.getAttribute("aria-hidden")).toBe("true")
  })
})

describe("the rail's brand slot", () => {
  const renderRail = (path: string, withToggle: boolean) =>
    render(
      <MemoryRouter initialEntries={[path]}>
        {withToggle ? <NavRibbon listOpen onToggleList={vi.fn()} /> : <NavRibbon />}
      </MemoryRouter>,
    )

  it.each([
    ["chat rail", "/", true],
    ["global rail", "/org", false],
  ])("shows the glass mark on the %s", (_name, path, withToggle) => {
    const { container } = renderRail(path, withToggle)
    expect(markImages(container)).toHaveLength(1)
  })

  it.each([
    ["chat rail", "/", true],
    ["global rail", "/org", false],
  ])("lets a portal emoji win on the %s", (_name, path, withToggle) => {
    settings.portalEmoji = "🦊"
    const { container } = renderRail(path, withToggle)
    expect(markImages(container)).toHaveLength(0)
    expect(container.textContent).toContain("🦊")
  })
})

describe("BrandFavicon", () => {
  const drawn: string[] = []

  beforeEach(() => {
    document.head.innerHTML = `<link rel="icon" type="image/svg+xml" href="${BRAND_FAVICON_SVG}"><link rel="icon" type="image/png" sizes="32x32" href="${BRAND_FAVICON_PNG}">`
    drawn.length = 0
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => ({
      font: "",
      textAlign: "",
      textBaseline: "",
      fillText: (glyph: string) => drawn.push(glyph),
    })) as never)
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,GLYPH")
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.head.innerHTML = ""
  })

  const hrefs = () => Array.from(document.querySelectorAll("link[rel='icon']"), (l) => l.getAttribute("href"))

  it("leaves the declared mark alone and draws nothing by default", () => {
    render(<BrandFavicon />)
    expect(hrefs()).toEqual([BRAND_FAVICON_SVG, BRAND_FAVICON_PNG])
    expect(drawn).toEqual([])
  })

  it("replaces every tab icon with the operator's glyph", () => {
    settings.portalEmoji = "🦊"
    render(<BrandFavicon />)
    expect(drawn).toEqual(["🦊"])
    expect(hrefs()).toEqual(["data:image/png;base64,GLYPH", "data:image/png;base64,GLYPH"])
    expect(document.querySelector("link[rel='icon']")?.getAttribute("type")).toBe("image/png")
  })

  it("restores the declared icons when the glyph is cleared", () => {
    settings.portalEmoji = "🦊"
    const { rerender } = render(<BrandFavicon />)
    settings.portalEmoji = null
    rerender(<BrandFavicon />)
    expect(hrefs()).toEqual([BRAND_FAVICON_SVG, BRAND_FAVICON_PNG])
    expect(document.querySelector("link[rel='icon']")?.getAttribute("type")).toBe("image/svg+xml")
  })
})

