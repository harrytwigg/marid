import { describe, expect, it } from "vitest"
import { engineDisplayName } from "../engine-names"

describe("engineDisplayName", () => {
  it("keeps the project's own spellings rather than a CSS capitalize", () => {
    // `text-transform: capitalize` renders these as "Musecode" and "Opencode".
    expect(engineDisplayName("musecode")).toBe("Muse Code")
    expect(engineDisplayName("opencode")).toBe("opencode")
    expect(engineDisplayName("claude")).toBe("Claude")
  })

  it("title-cases an engine it does not know, so a new one still reads", () => {
    expect(engineDisplayName("brandnew")).toBe("Brandnew")
  })
})
