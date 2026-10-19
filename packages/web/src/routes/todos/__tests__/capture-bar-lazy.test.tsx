import { act, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/* The quick-capture bar loads on demand. Each case gets a fresh copy of the lazy module, so it
 * sees its own mocked chunk: one that arrives when the test lets it, one that never can. */

beforeEach(() => vi.resetModules())
afterEach(() => vi.doUnmock("../quick-add/capture-bar"))

describe("LazyQuickCaptureBar", () => {
  it("stands an inert scrim in until the chunk arrives, then shows the bar", async () => {
    let arrive: () => void = () => {}
    const gate = new Promise<void>((resolve) => { arrive = resolve })
    vi.doMock("../quick-add/capture-bar", async () => {
      await gate
      return { QuickCaptureBar: () => <div data-testid="quick-capture">bar</div> }
    })
    const { LazyQuickCaptureBar } = await import("../quick-add/capture-bar-lazy")
    render(<LazyQuickCaptureBar onClose={vi.fn()} onFailed={vi.fn()} />)

    const scrim = screen.getByTestId("quick-capture-loading")
    expect(scrim.getAttribute("aria-hidden")).toBe("true")
    expect(scrim.className).toContain("pointer-events-none")
    expect(scrim.querySelector("button, a, input, [tabindex]")).toBeNull()
    expect(screen.queryByTestId("quick-capture")).toBeNull()

    await act(async () => arrive())
    await screen.findByTestId("quick-capture")
    expect(screen.queryByTestId("quick-capture-loading")).toBeNull()
  })

  it("takes the scrim down and says so when the chunk cannot be fetched", async () => {
    vi.doMock("../quick-add/capture-bar", () => {
      throw new Error("Failed to fetch dynamically imported module")
    })
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { LazyQuickCaptureBar } = await import("../quick-add/capture-bar-lazy")
    const onFailed = vi.fn()
    const notice = vi.fn()
    // Each case has its own copy of the modules, so the surface is registered on the copy the dialog reads.
    const { registerNoticeSink } = await import("@/lib/notices")
    registerNoticeSink(notice)
    render(<LazyQuickCaptureBar onClose={vi.fn()} onFailed={onFailed} />)

    await waitFor(() => expect(onFailed).toHaveBeenCalledTimes(1))
    expect(notice).toHaveBeenCalledWith({ title: "Quick capture couldn't load. Reload the page and try again.", level: "error" })
    expect(screen.queryByTestId("quick-capture-loading")).toBeNull()
    expect(screen.queryByTestId("quick-capture")).toBeNull()
  })

  it("preloads without throwing, and reports nothing, when the chunk cannot be fetched", async () => {
    vi.doMock("../quick-add/capture-bar", () => {
      throw new Error("offline")
    })
    const { preloadQuickCapture } = await import("../quick-add/capture-bar-lazy")
    expect(() => preloadQuickCapture()).not.toThrow()
  })
})
