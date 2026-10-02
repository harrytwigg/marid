import { act, cleanup, render, waitFor } from "@testing-library/react"
import type { GatewayEvent } from "@jinn/gateway-events"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { queryClient } from "@/lib/query-client"
import { buildScreenContext } from "../context/surface-adapters"
import { describeLocation } from "../context/page-snapshot"
import { createVisualCapture } from "../context/visual-capture"
import { TalkSurface } from "../talk-surface"
import { clearTalkNavigator, registerTalkNavigator } from "../tools/router-handle"
import { applyTalkUiEffect } from "../transport/ui-effects"
import { createProactiveCueReceiver } from "../transport/proactive-cues"
import { createTalkDriver } from "../transport/session-driver"
import {
  authFetch,
  CONFIGURED,
  handle,
  json,
  OPENED,
  Probe,
  resetHarness,
} from "../transport/__tests__/talk-session-harness"
import { browserControlFixture } from "../transport/__tests__/control-fixture"
import { FakeConnection, connect } from "../transport/__tests__/fake-connection"
import {
  readResumableTalkSession,
  rememberResumableTalkSession,
} from "../talk-session-store"

let originalGetContext: typeof HTMLCanvasElement.prototype.getContext

vi.mock("@/lib/auth", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/auth")>()
  return { ...original, authFetch: (...args: unknown[]) => authFetch(...args) }
})

function page(markup: string): HTMLElement {
  const root = document.createElement("main")
  root.innerHTML = markup
  document.body.append(root)
  return root
}

function seedBlockedTodo(): void {
  queryClient.setQueryData(["work-item", "OPS-42"], {
    workItem: {
      id: "OPS-42",
      version: 3,
      title: "Connect the release lane",
      status: "blocked",
      body: "Waiting for a compatible test environment.",
      assignee: "platform-lead",
      department: "platform",
      priority: 2,
      sourceRef: "session:session-related",
    },
    events: [{
      id: "event-blocked",
      kind: "status_change",
      fromStatus: "executing",
      toStatus: "blocked",
      detail: { note: "The sandbox credential is not available yet.", blockKind: "dependency" },
    }],
    relations: [],
  })
  queryClient.setQueryData(["work-item-sessions", "OPS-42"], [
    { id: "session-related", title: "Release lane discussion", status: "idle" },
  ])
}

function proactiveFrame(
  overrides: Partial<Extract<GatewayEvent, { event: "talk:proactive-cue" }>["payload"]> = {},
): GatewayEvent {
  return {
    event: "talk:proactive-cue",
    payload: {
      receiptId: "receipt-1",
      talkSessionId: "talk-1",
      topicId: "topic-ops-42",
      disposition: "quiet",
      urgency: "routine",
      summary: "The blocked Todo changed.",
      uiEffect: { type: "refresh", target: "todos" },
      ...overrides,
    },
  }
}

beforeEach(() => {
  originalGetContext = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = (() => null) as never
  resetHarness()
  queryClient.clear()
  clearTalkNavigator()
})

afterEach(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext
  cleanup()
  queryClient.clear()
  clearTalkNavigator()
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe("the Talk driving journey", () => {
  it("keeps Aurora as the only Talk UI while a blocked Todo is grounded semantically", async () => {
    seedBlockedTodo()
    const root = page(`
      <h1>Connect the release lane</h1>
      <p data-talk-context>Blocked while the sandbox is unavailable.</p>
      <button data-talk-target="related-chat">Open related chat</button>
    `)
    render(<TalkSurface />)
    const context = buildScreenContext({
      location: describeLocation("/todos/OPS-42", "?status=blocked"),
      browserInstanceId: "browser-acceptance",
      root,
      revision: 4,
      capturedAt: "2026-08-18T09:00:00.000Z",
    })
    const renderVisual = vi.fn()
    const visual = createVisualCapture({ render: renderVisual })
    const result = await visual.request({
      context,
      reason: "todo-description",
      requestKey: "utterance-what-am-i-looking-at",
      root,
    })
    expect(context).toMatchObject({
      routeId: "todo-detail",
      freshness: "complete",
      filters: {},
      selectedObject: {
        id: "OPS-42",
        title: "Connect the release lane",
        status: "blocked",
        fields: { blockedReason: "The sandbox credential is not available yet." },
        relations: [{ kind: "session", id: "session-related", title: "Release lane discussion" }],
      },
    })
    expect(result).toMatchObject({ ok: false, code: "structured-context-sufficient" })
    expect(renderVisual).not.toHaveBeenCalled()
    expect(document.querySelectorAll("[data-talk-orb]")).toHaveLength(1)
    expect(document.querySelector("[data-situation-sheet], [data-talk-undo-strip], [data-media-preview]")).toBeNull()
  })

  it("lands related-chat navigation in the visible page before the effect resolves", async () => {
    const root = page('<h1>Connect the release lane</h1><div data-talk-target="related-chat" tabindex="-1"></div>')
    const landed: string[] = []
    registerTalkNavigator(async (path) => {
      landed.push(path)
      root.querySelector("h1")!.textContent = "Release lane discussion"
    })
    await applyTalkUiEffect({ navigate: "/?session=session-related" })
    expect(landed).toEqual(["/?session=session-related"])
    expect(root.querySelector("h1")?.textContent).toBe("Release lane discussion")
  })

  it("admits exactly one bounded visual fallback for a declared org chart gap", async () => {
    const root = page(`
      <h1>Organization</h1>
      <div data-talk-visual-gap="org-chart-spatial-layout">Build is left of verify.</div>
      <section data-talk-orb-overlay>Private Aurora chrome</section>
    `)
    const context = buildScreenContext({
      location: describeLocation("/org", ""),
      browserInstanceId: "browser-acceptance",
      root,
      revision: 9,
      capturedAt: "2026-08-18T09:01:00.000Z",
    })
    const renderVisual = vi.fn(async (clone: HTMLElement, options: { maxWidth: number; maxHeight: number; maxBytes: number }) => {
      expect(clone.querySelector("[data-talk-orb-overlay]")).toBeNull()
      expect(options).toMatchObject({ maxWidth: 1_280, maxHeight: 1_280, maxBytes: 180_000 })
      return { dataUrl: "data:image/webp;base64,aaaa", width: 960, height: 600, bytes: 3 }
    })
    const visual = createVisualCapture({ render: renderVisual, now: () => 25 })
    const request = {
      context,
      reason: "org-chart-spatial-layout",
      requestKey: "utterance-leftmost-node",
      root,
    }
    const first = await visual.request(request)
    const replay = await visual.request(request)
    expect(first).toMatchObject({
      ok: true,
      receipt: {
        requestKey: "utterance-leftmost-node",
        contextRevision: 9,
        bytes: 3,
        estimatedImageTokens: expect.any(Number),
      },
    })
    expect(replay).toMatchObject({ ok: false, code: "visual-fallback-already-used" })
    expect(renderVisual).toHaveBeenCalledTimes(1)
    if (first.ok) expect(first.receipt.estimatedImageTokens).toBeGreaterThan(0)
  })

  it("recovers a cold parked chat on a gesture and starts over without deleting normal chat history", async () => {
    rememberResumableTalkSession("talk-1")
    let opens = 1
    authFetch.mockImplementation(async (url: string, init: RequestInit = {}) => {
      if (url === "/api/talk/sessions/talk-1" && init.method === "GET") {
        return json({ ...OPENED, state: "parked", token: undefined, topicMemory: "Remember the first decision." })
      }
      if (url.endsWith("/resume")) {
        return json({
          token: "secret-resumed",
          expiresAt: 1_700_001_200,
          browserInstanceId: OPENED.browserInstanceId,
          credentialGeneration: 2,
        })
      }
      if (url === "/api/talk/config") return json(CONFIGURED)
      if (url === "/api/talk/sessions" && init.method === "POST") {
        opens += 1
        return json({ ...OPENED, id: `talk-${opens}`, token: `secret-${opens}` }, 201)
      }
      return json({ ok: true })
    })
    render(<Probe />)
    await waitFor(() => expect(handle.parked).toBe(true))
    expect(connect).not.toHaveBeenCalled()
    await act(async () => handle.toggle())
    await waitFor(() => expect(handle.active).toBe(true))
    expect(FakeConnection.opened[0]?.token).toBe("secret-resumed")
    await act(async () => handle.startOver())
    await waitFor(() => expect(readResumableTalkSession()).toBe("talk-2"))
    const deletes = authFetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "DELETE")
    expect(deletes.map(([url]) => url)).toEqual(["/api/talk/sessions/talk-1"])
    expect(authFetch.mock.calls.some(([url]) => String(url).startsWith("/api/sessions/"))).toBe(false)
    expect(FakeConnection.opened[0]?.closes).toBe(1)
    expect(handle.active).toBe(true)
  })

  it("deduplicates proactive cues, records barge-in, and leaves provider failure visible on Aurora", async () => {
    const sent: Array<Record<string, unknown>> = []
    const states: string[] = []
    const errors: string[] = []
    const driver = createTalkDriver({
      sessionId: "talk-1",
      manifest: browserControlFixture(),
      send: (event) => sent.push(event),
      onState: (state) => states.push(state),
      onError: (message) => errors.push(message),
    })
    const apply = vi.fn().mockResolvedValue(undefined)
    const acknowledge = vi.fn().mockResolvedValue(undefined)
    const speak = vi.fn((summary: string, receiptId: string, settled: (outcome: "completed" | "interrupted") => void) => (
      driver.cue(summary, receiptId, settled)
    ))
    const receive = createProactiveCueReceiver({ sessionId: () => "talk-1", speak, apply, acknowledge })
    const quiet = proactiveFrame()
    await receive(quiet)
    await receive(quiet)
    expect(apply).toHaveBeenCalledTimes(1)
    expect(speak).not.toHaveBeenCalled()
    const urgent = proactiveFrame({
      receiptId: "receipt-urgent",
      disposition: "spoken",
      urgency: "urgent",
      uiEffect: null,
    })
    await receive(urgent)
    await receive(urgent)
    expect(speak).toHaveBeenCalledTimes(1)
    expect(sent.filter((event) => event.type === "response.create")).toHaveLength(1)
    driver.receive(JSON.stringify({ type: "response.created" }))
    driver.receive(JSON.stringify({ type: "input_audio_buffer.speech_started" }))
    await waitFor(() => expect(acknowledge).toHaveBeenCalledWith("talk-1", "receipt-urgent", "interrupted"))
    expect(sent.filter((event) => event.type === "response.cancel")).toHaveLength(0)
    driver.receive(JSON.stringify({ type: "error", error: { message: "Realtime unavailable." } }))
    render(<TalkSurface state={states.at(-1) as "error"} />)
    expect(errors).toEqual(["Realtime unavailable."])
    expect(document.querySelector("[data-talk-orb]")?.getAttribute("data-orb-state")).toBe("error")
    expect(document.querySelector("[data-situation-sheet], [data-talk-undo-strip], [data-media-preview]")).toBeNull()
  })
})
