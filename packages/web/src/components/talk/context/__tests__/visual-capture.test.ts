import { describe, expect, it, vi } from "vitest"
import type { TalkScreenContext } from "../page-snapshot"
import { createVisualCapture } from "../visual-capture"

const partialContext = (revision = 9): TalkScreenContext => ({
  version: 1,
  revision,
  routeId: "org",
  kind: "org",
  path: "/org",
  params: {},
  filters: {},
  selection: null,
  capturedAt: "2026-08-18T08:00:00.000Z",
  freshness: "partial",
  missing: ["org-chart-spatial-layout"],
  title: "Org chart",
  selectedObject: null,
  visibleItems: [],
  controls: [],
  meaningfulText: "Org chart",
  browserInstanceId: "browser-1",
  focus: null,
  hidden: false,
  visualGaps: ["org-chart-spatial-layout"],
})

describe("bounded visual fallback", () => {
  it("refuses capture when structured context is complete", async () => {
    const render = vi.fn()
    const capture = createVisualCapture({ render, now: () => 20 })

    const result = await capture.request({
      context: { ...partialContext(), freshness: "complete", missing: [], visualGaps: [] },
      reason: "org-chart-spatial-layout",
      requestKey: "utterance-1",
      root: document.createElement("main"),
    })

    expect(result).toMatchObject({ ok: false, code: "structured-context-sufficient" })
    expect(render).not.toHaveBeenCalled()
  })

  it("captures one bounded image for a declared gap, excludes private chrome, and records cost", async () => {
    const render = vi.fn().mockResolvedValue({
      dataUrl: `data:image/webp;base64,${"a".repeat(2_000)}`,
      width: 1200,
      height: 750,
      bytes: 1_500,
    })
    let time = 100
    const capture = createVisualCapture({ render, now: () => (time += 25) })
    const root = document.createElement("main")
    root.innerHTML = '<h1>Release train</h1><input type="password" value="never-render"><div data-talk-orb-overlay>orb</div>'

    const [first, duplicate] = await Promise.all([
      capture.request({ context: partialContext(), reason: "org-chart-spatial-layout", requestKey: "utterance-1", root }),
      capture.request({ context: partialContext(), reason: "org-chart-spatial-layout", requestKey: "utterance-1", root }),
    ])

    expect(first).toMatchObject({
      ok: true,
      event: {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_image", image_url: expect.stringMatching(/^data:image\/webp;base64,/) }],
        },
      },
      receipt: {
        contextRevision: 9,
        reason: "org-chart-spatial-layout",
        bytes: 1_500,
        width: 1200,
        height: 750,
        estimatedImageTokens: expect.any(Number),
        latencyMs: 25,
      },
    })
    expect(duplicate).toMatchObject({ ok: false, code: "visual-fallback-already-used" })
    expect(render).toHaveBeenCalledTimes(1)
    expect(render).toHaveBeenCalledWith(expect.any(HTMLElement), expect.objectContaining({
      exclude: expect.arrayContaining(["[data-talk-orb-overlay]", "[data-talk-secret]"]),
      maxWidth: 1280,
      maxHeight: 1280,
      maxBytes: 180_000,
    }))
    const renderedRoot = render.mock.calls[0]![0] as HTMLElement
    expect(renderedRoot.textContent).toContain("Release train")
    expect(renderedRoot.innerHTML).not.toContain("never-render")
    expect(renderedRoot.innerHTML).not.toContain("data-talk-orb-overlay")

    const laterQuestion = await capture.request({
      context: partialContext(),
      reason: "org-chart-spatial-layout",
      requestKey: "utterance-2",
      root,
    })
    expect(laterQuestion.ok).toBe(true)
    expect(render).toHaveBeenCalledTimes(2)
  })

  it("fails closed for an undeclared gap and an oversized raster", async () => {
    const render = vi.fn().mockResolvedValue({
      dataUrl: "data:image/webp;base64,aaaa",
      width: 1200,
      height: 750,
      bytes: 180_001,
    })
    const capture = createVisualCapture({ render, now: () => 20 })
    const root = document.createElement("main")

    await expect(capture.request({
      context: partialContext(),
      reason: "some-other-gap",
      requestKey: "utterance-1",
      root,
    })).resolves.toMatchObject({ ok: false, code: "visual-gap-not-declared" })
    expect(render).not.toHaveBeenCalled()

    await expect(capture.request({
      context: partialContext(),
      reason: "org-chart-spatial-layout",
      requestKey: "utterance-1",
      root,
    })).resolves.toMatchObject({ ok: false, code: "visual-fallback-out-of-bounds" })
  })
})
