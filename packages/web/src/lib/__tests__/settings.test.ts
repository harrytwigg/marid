import { afterEach, describe, expect, it } from "vitest"

import { loadSettings } from "../settings"

afterEach(() => localStorage.clear())

describe("loadSettings", () => {
  it("drops the retired portalIcon from a saved copy and keeps the portal emoji", () => {
    localStorage.setItem("jinn-settings", JSON.stringify({ portalIcon: "★", portalEmoji: "🦊" }))

    const settings = loadSettings()

    expect(settings.portalEmoji).toBe("🦊")
    expect("portalIcon" in settings).toBe(false)
  })
})
