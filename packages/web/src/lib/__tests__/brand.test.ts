import { describe, expect, it } from "vitest"
import { customBrandGlyph } from "../brand"

describe("customBrandGlyph", () => {
  it("is null when the operator set nothing, so the default mark shows", () => {
    expect(customBrandGlyph({ portalEmoji: null, portalIcon: null })).toBeNull()
    expect(customBrandGlyph({ portalEmoji: "  ", portalIcon: "" })).toBeNull()
  })

  it("returns the portal emoji", () => {
    expect(customBrandGlyph({ portalEmoji: "🦊", portalIcon: null })).toBe("🦊")
  })

  it("uses the portal icon when there is no emoji", () => {
    expect(customBrandGlyph({ portalEmoji: null, portalIcon: "★" })).toBe("★")
  })

  it("lets the emoji win over the icon", () => {
    expect(customBrandGlyph({ portalEmoji: "🦊", portalIcon: "★" })).toBe("🦊")
  })
})
