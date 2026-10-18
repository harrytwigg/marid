import { afterEach, describe, expect, it, vi } from "vitest"
import { clearNoticeSink, registerNoticeSink } from "@/lib/notices"
import { loadFailureMessage, reportLoadFailure } from "../report-load-failure"

afterEach(() => {
  clearNoticeSink()
  vi.restoreAllMocks()
})

describe("reportLoadFailure", () => {
  it("raises one error notice naming what could not load, on the app's notice surface", () => {
    const sink = vi.fn()
    registerNoticeSink(sink)

    reportLoadFailure("Quick capture")

    expect(sink).toHaveBeenCalledTimes(1)
    expect(sink).toHaveBeenCalledWith({ title: "Quick capture couldn't load. Reload the page and try again.", level: "error" })
  })

  it("uses one wording for everything that loads lazily", () => {
    expect(loadFailureMessage("The dialog")).toBe("The dialog couldn't load. Reload the page and try again.")
  })

  it("says it in the console when no surface is mounted, instead of dropping it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    reportLoadFailure("The menu")

    expect(warn).toHaveBeenCalledWith("[notice] error: The menu couldn't load. Reload the page and try again.")
  })
})
