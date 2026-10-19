import { render, cleanup, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { OrbCanvas } from "../orb-canvas"

/** jsdom has no 2D context, so the canvas API is a spy the paints are counted on. */
function fakeContext() {
  return {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    ellipse: vi.fn(),
    clip: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    globalCompositeOperation: "source-over",
    globalAlpha: 1,
    fillStyle: "",
  }
}

let ctx: ReturnType<typeof fakeContext>
let originalGetContext: HTMLCanvasElement["getContext"]

/** Every paint starts with one `clearRect`. */
const paints = () => ctx.clearRect.mock.calls.length

function stubReducedMotion(reduce: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduce && query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }))
}

const energyRef = { current: { input: 0, output: 0 } }

beforeEach(() => {
  ctx = fakeContext()
  originalGetContext = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ctx) as never
})

afterEach(() => {
  cleanup()
  HTMLCanvasElement.prototype.getContext = originalGetContext
  document.documentElement.removeAttribute("data-theme")
  document.documentElement.removeAttribute("data-transparency")
  vi.unstubAllGlobals()
})

describe("OrbCanvas under prefers-reduced-motion: reduce", () => {
  beforeEach(() => stubReducedMotion(true))

  it("never starts an animation loop", () => {
    const raf = vi.fn(() => 1)
    vi.stubGlobal("requestAnimationFrame", raf)
    stubReducedMotion(true)

    render(<OrbCanvas state="idle" energyRef={energyRef} size={64} />)

    expect(raf).not.toHaveBeenCalled()
  })

  it("paints exactly once per state change", () => {
    const raf = vi.fn(() => 1)
    vi.stubGlobal("requestAnimationFrame", raf)
    stubReducedMotion(true)

    const view = render(<OrbCanvas state="idle" energyRef={energyRef} size={64} />)
    expect(paints()).toBe(1)

    view.rerender(<OrbCanvas state="thinking" energyRef={energyRef} size={64} />)
    expect(paints()).toBe(2)

    view.rerender(<OrbCanvas state="assistant_speaking" energyRef={energyRef} size={64} />)
    expect(paints()).toBe(3)
    expect(raf).not.toHaveBeenCalled()
  })

  it("paints each state in its own geometry, not one frozen shape for all", () => {
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1))
    stubReducedMotion(true)

    const traces: string[] = []
    for (const state of ["idle", "listening", "user_speaking", "thinking", "assistant_speaking", "error"] as const) {
      ctx = fakeContext()
      HTMLCanvasElement.prototype.getContext = vi.fn(() => ctx) as never
      const view = render(<OrbCanvas state={state} energyRef={energyRef} size={64} />)
      // Exactly one frame per state — still, but in that state's own shape.
      expect(paints(), state).toBe(1)
      traces.push(ctx.ellipse.mock.calls.map((c) => c.join(",")).join("|"))
      view.unmount()
    }

    expect(new Set(traces).size).toBe(traces.length)
  })

  it("still paints the layered material, so the orb reads as parked, not broken", () => {
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1))
    stubReducedMotion(true)

    render(<OrbCanvas state="listening" energyRef={energyRef} size={64} />)

    expect(ctx.createRadialGradient).toHaveBeenCalled()
    // One frame, but the whole sphere: body, lobes, core, specular, rim. A
    // single fill here would be the flat blob this work replaced.
    expect(ctx.fill.mock.calls.length).toBeGreaterThan(1)
  })
})

describe("OrbCanvas when the palette changes under it", () => {
  beforeEach(() => stubReducedMotion(true))

  /**
   * The hard case is the OS scheme flipping while the theme setting sits on
   * "system": the provider rewrites `data-theme` and changes no React state, so
   * a repaint keyed on the setting never fires. Reduced motion removes the
   * animation loop that would otherwise hide the staleness on the next frame.
   */
  it("repaints when the root theme attribute flips without a rerender", async () => {
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1))
    stubReducedMotion(true)
    document.documentElement.setAttribute("data-theme", "dark")

    render(<OrbCanvas state="idle" energyRef={energyRef} size={64} />)
    expect(paints()).toBe(1)

    document.documentElement.setAttribute("data-theme", "light")

    await waitFor(() => expect(paints()).toBe(2))
  })

  it("repaints when Reduced transparency is switched on the root", async () => {
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1))
    stubReducedMotion(true)
    document.documentElement.setAttribute("data-theme", "dark")

    render(<OrbCanvas state="idle" energyRef={energyRef} size={64} />)
    expect(paints()).toBe(1)

    document.documentElement.setAttribute("data-transparency", "reduced")

    await waitFor(() => expect(paints()).toBe(2))
  })

  it("does not repaint when an unrelated root attribute changes", async () => {
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1))
    stubReducedMotion(true)
    document.documentElement.setAttribute("data-theme", "dark")

    render(<OrbCanvas state="idle" energyRef={energyRef} size={64} />)
    document.documentElement.setAttribute("lang", "en")

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(paints()).toBe(1)
  })
})

describe("OrbCanvas with motion allowed", () => {
  it("runs an animation loop and repaints on every frame", () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb))
    vi.stubGlobal("cancelAnimationFrame", vi.fn())
    stubReducedMotion(false)

    render(<OrbCanvas state="idle" energyRef={energyRef} size={64} />)
    expect(frames).toHaveLength(1)
    expect(paints()).toBe(0)

    frames[0](16)
    expect(paints()).toBe(1)
    frames[1](32)
    expect(paints()).toBe(2)
  })

  it("cancels the loop when it unmounts", () => {
    const cancel = vi.fn()
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 7))
    vi.stubGlobal("cancelAnimationFrame", cancel)
    stubReducedMotion(false)

    render(<OrbCanvas state="idle" energyRef={energyRef} size={64} />).unmount()

    expect(cancel).toHaveBeenCalledWith(7)
  })

  it("scales the backing store by the device pixel ratio", () => {
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1))
    vi.stubGlobal("cancelAnimationFrame", vi.fn())
    vi.stubGlobal("devicePixelRatio", 2)
    stubReducedMotion(false)

    const { container } = render(<OrbCanvas state="idle" energyRef={energyRef} size={64} />)

    const canvas = container.querySelector("canvas")!
    expect(canvas.width).toBe(128)
    expect(canvas.height).toBe(128)
    expect(ctx.setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0)
  })

  it("hides the canvas from assistive technology", () => {
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1))
    vi.stubGlobal("cancelAnimationFrame", vi.fn())
    stubReducedMotion(false)

    const { container } = render(<OrbCanvas state="idle" energyRef={energyRef} size={64} />)

    expect(container.querySelector("canvas")).toHaveProperty("ariaHidden", "true")
  })
})
