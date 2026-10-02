import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { describeLocation, type TalkScreenContext } from "@/components/talk/context/page-snapshot"
import { publishScreenContext, resetPageContext } from "@/components/talk/context/page-context-store"
import { createVisualCapture } from "@/components/talk/context/visual-capture"
import { toolDefinitions } from "@/components/talk/tools/registry"
import { createTalkDriver } from "../session-driver"
import { browserControlFixture } from "./control-fixture"

const authFetch = vi.fn()
vi.mock("@/lib/auth", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/auth")>()
  return { ...original, authFetch: (...args: unknown[]) => authFetch(...args) }
})

function screen(): TalkScreenContext {
  return {
    ...describeLocation("/org", ""),
    version: 1,
    revision: 11,
    routeId: "org",
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
  }
}

beforeEach(() => {
  document.body.innerHTML = '<main id="root"><h1>Release train</h1></main>'
  resetPageContext()
  publishScreenContext(screen())
  authFetch.mockReset().mockResolvedValue(new Response("{}", { status: 200 }))
})

afterEach(() => {
  resetPageContext()
  document.body.replaceChildren()
})

describe("session visual fallback", () => {
  it("declares the bounded capture tool", () => {
    expect(toolDefinitions().some((tool) => tool.name === "capture_current_view")).toBe(true)
  })

  it("sends one input image for one provider utterance and records a public receipt", async () => {
    const render = vi.fn().mockResolvedValue({
      dataUrl: "data:image/webp;base64,aaaa",
      width: 900,
      height: 600,
      bytes: 3,
    })
    const sent: Array<Record<string, unknown>> = []
    const driver = createTalkDriver({
      sessionId: "talk-1",
      manifest: browserControlFixture(),
      send: (event) => sent.push(event),
      onState: () => {},
      onError: () => {},
      visualCapture: createVisualCapture({ render, now: () => 10 }),
    })
    driver.receive(JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      event_id: "event-user-1",
      item_id: "item-user-1",
      transcript: "Which node is leftmost?",
    }))
    const call = (callId: string) => driver.receive(JSON.stringify({
      type: "response.function_call_arguments.done",
      event_id: `event-${callId}`,
      item_id: `item-${callId}`,
      call_id: callId,
      name: "capture_current_view",
      arguments: JSON.stringify({ reason: "org-chart-spatial-layout" }),
    }))
    call("call-1")
    call("call-2")

    await vi.waitFor(() => expect(sent.filter((event) => {
      const content = (event.item as { content?: unknown[] } | undefined)?.content
      return Array.isArray(content) && content.some((part) => (part as { type?: string }).type === "input_image")
    })).toHaveLength(1))
    expect(render).toHaveBeenCalledTimes(1)
    const outputs = sent.filter((event) => (event.item as { type?: string } | undefined)?.type === "function_call_output")
    expect(outputs).toHaveLength(2)
    expect(outputs.map((event) => JSON.parse(String((event.item as { output: string }).output))))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ ok: true, data: expect.objectContaining({ contextRevision: expect.any(Number), bytes: 3 }) }),
        expect.objectContaining({ ok: false, code: "visual-fallback-already-used" }),
      ]))

    driver.receive(JSON.stringify({ type: "response.done", response: { usage: {} } }))
    await vi.waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1))
    const [, init] = authFetch.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as { visualReceipts: unknown[] }
    expect(body.visualReceipts).toEqual([
      expect.objectContaining({ requestKey: "item-user-1", contextRevision: expect.any(Number), bytes: 3 }),
    ])
  })
})
