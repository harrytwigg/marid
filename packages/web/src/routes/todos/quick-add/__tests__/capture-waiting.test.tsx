import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { GatewayEvent, GatewayEventListener } from "@hundredfold/gateway-events"
import type { TodoCaptureWire } from "@/lib/api"

/**
 * A capture that is parked rather than progressing.
 *
 * The rate limiter puts a Shaper to sleep and resumes it on its own, so the
 * stage is honestly unchanged for as long as that lasts — but an unexplained
 * spinner on a session that will not move for an hour reads as a hang. These
 * pin the one thing the strip is allowed to add: the gateway's reason, beside
 * the step rather than in place of it, and gone the moment work resumes.
 * Shares the bar with capture-bar.test.tsx (text path) and
 * capture-bar-voice.test.tsx (dictation).
 */

const startTodoCapture = vi.hoisted(() => vi.fn())
const getTodoCapture = vi.hoisted(() => vi.fn())

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: { startTodoCapture, getTodoCapture } }
})

let listener: ((event: string, payload: unknown) => void) | undefined
vi.mock("@/hooks/use-gateway", () => ({
  useGateway: () => ({
    connectionSeq: 1,
    events: [],
    subscribe: (next: GatewayEventListener) => {
      listener = (event, payload) => next({ event, payload } as GatewayEvent)
      return () => { listener = undefined }
    },
  }),
}))

// The mic is not part of this contract; it only has to exist.
vi.mock("@/hooks/use-stt", () => ({
  useStt: vi.fn(() => ({
    state: "idle", available: false, downloadProgress: null, analyser: null,
    languages: ["en"], selectedLanguage: "en", error: null,
    cycleLanguage: vi.fn(), handleMicClick: vi.fn(), startRecording: vi.fn(),
    stopRecording: vi.fn(), cancelRecording: vi.fn(), startDownload: vi.fn(),
    dismissDownload: vi.fn(), dismissError: vi.fn(),
  })),
}))

import { QuickCaptureBar } from "../capture-bar"

function wire(over: Partial<TodoCaptureWire> = {}): TodoCaptureWire {
  return {
    captureId: "cap-1",
    sessionId: "cap-1",
    stage: "starting",
    workItemId: null,
    workItemTitle: null,
    routedTo: null,
    extraWorkItemIds: [],
    error: null,
    waitingReason: null,
    ...over,
  }
}

function renderBar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <QuickCaptureBar onClose={() => {}} />
    </QueryClientProvider>,
  )
}

async function type(text: string) {
  const input = screen.getByTestId("quick-capture-input")
  fireEvent.change(input, { target: { value: text } })
  return input
}

beforeEach(() => {
  vi.clearAllMocks()
  startTodoCapture.mockResolvedValue(wire())
  getTodoCapture.mockResolvedValue(wire())
})

afterEach(() => { listener = undefined })

describe("QuickCaptureBar — a capture the rate limiter parked", () => {
  // A rate-limited Shaper is asleep on purpose, and an unexplained spinner on a
  // session that will not move for an hour reads as a hang. The stage stays
  // exactly where the wire put it; only the reason is added beside it.
  it("says why a waiting Shaper is waiting instead of spinning silently", async () => {
    const reason = "Codex usage limit — resumes 2026-08-24T12:00:00.000Z"
    renderBar()
    const input = await type("a capture that hits the usage limit")
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }) })

    expect(screen.queryByTestId("capture-waiting")).toBeNull()

    getTodoCapture.mockResolvedValue(wire({ stage: "starting", waitingReason: reason }))
    await act(async () => { listener?.("todo-capture:stage", { captureId: "cap-1", stage: "starting", workItemId: null }) })

    await waitFor(() => expect(screen.getByTestId("capture-waiting").textContent).toContain(reason))
    // Waiting is not failing, and it is not progress either.
    expect(screen.queryByTestId("capture-error")).toBeNull()
    expect(screen.queryByTestId("capture-step-shaping")).toBeNull()
  })

  it("drops the waiting note once the Shaper is working again", async () => {
    renderBar()
    const input = await type("a capture that resumes")
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }) })

    getTodoCapture.mockResolvedValue(wire({ stage: "starting", waitingReason: "Codex usage limit — waiting for reset" }))
    await act(async () => { listener?.("todo-capture:stage", { captureId: "cap-1", stage: "starting", workItemId: null }) })
    await waitFor(() => expect(screen.getByTestId("capture-waiting")).toBeTruthy())

    getTodoCapture.mockResolvedValue(wire({ stage: "shaping" }))
    await act(async () => { listener?.("todo-capture:stage", { captureId: "cap-1", stage: "shaping", workItemId: null }) })

    await waitFor(() => expect(screen.queryByTestId("capture-waiting")).toBeNull())
  })
})
