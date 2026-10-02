import { describe, expect, it } from "vitest"
import { describeLocation } from "../page-snapshot"
import { semanticScreenChanged } from "../screen-context-diff"
import { buildScreenContext } from "../surface-adapters"

function context(capturedAt: string, text = "Org chart") {
  const root = document.createElement("main")
  root.innerHTML = `<h1>${text}</h1>`
  return buildScreenContext({
    location: describeLocation("/org", ""),
    browserInstanceId: "browser-1",
    root,
    capturedAt,
  })
}

describe("semantic screen diffs", () => {
  it("ignores clocks and revisions when nothing meaningful changed", () => {
    expect(semanticScreenChanged(
      { ...context("2026-08-18T08:00:00.000Z"), revision: 3 },
      { ...context("2026-08-18T08:01:00.000Z"), revision: 4 },
    )).toBe(false)
  })

  it("detects meaningful visible state changes", () => {
    expect(semanticScreenChanged(
      context("2026-08-18T08:00:00.000Z", "Release train"),
      context("2026-08-18T08:00:01.000Z", "Release train failed"),
    )).toBe(true)
  })
})
