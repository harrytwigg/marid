import { describe, expect, it } from "vitest"
import { customBrandGlyph } from "../brand"

describe("customBrandGlyph", () => {
  it("is null when the operator set nothing, so the default mark shows", () => {
    expect(customBrandGlyph({ portalEmoji: null })).toBeNull()
    expect(customBrandGlyph({ portalEmoji: "  " })).toBeNull()
  })

  it("returns the portal emoji, trimmed", () => {
    expect(customBrandGlyph({ portalEmoji: " 🦊 " })).toBe("🦊")
  })
})
