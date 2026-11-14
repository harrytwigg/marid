import { act, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { GatewayEventListener } from "@hundredfold/gateway-events"
import type { TodoCaptureWire } from "@/lib/api"

/**
 * The voice path and the one confirm it earns.
 *
 * A dictation can be misheard, and a capture spends real money, so the
 * transcript lands in the field and waits for a tap rather than firing. These
 * pin that gap: nothing is posted until the operator confirms, and what they
 * confirm is what they can still edit. Shares the bar with
 * capture-bar.test.tsx, which owns the text path and the pipeline strip.
 */

const startTodoCapture = vi.hoisted(() => vi.fn())
const getTodoCapture = vi.hoisted(() => vi.fn())

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: { startTodoCapture, getTodoCapture } }
})

// The voice path never drives a gateway frame — its whole contract is what
// happens before anything is posted — so this only has to be inert.
vi.mock("@/hooks/use-gateway", () => ({
  useGateway: () => ({ connectionSeq: 1, events: [], subscribe: (_next: GatewayEventListener) => () => {} }),
}))

const stt = vi.hoisted(() => ({
  state: "idle" as string,
  available: true,
  downloadProgress: null as number | null,
  analyser: null,
  languages: ["en"],
  selectedLanguage: "en",
  error: null as string | null,
  cycleLanguage: vi.fn(),
  handleMicClick: vi.fn(),
  startRecording: vi.fn(),
  stopRecording: vi.fn<() => Promise<string | null>>(),
  cancelRecording: vi.fn(),
  startDownload: vi.fn(),
  dismissDownload: vi.fn(),
  dismissError: vi.fn(),
}))
vi.mock("@/hooks/use-stt", () => ({ useStt: vi.fn(() => stt) }))

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
  stt.state = "idle"
  stt.error = null
  stt.stopRecording.mockResolvedValue("the closed rail scrolls under the header")
})

afterEach(() => { vi.clearAllMocks() })

describe("QuickCaptureBar — the voice path and its one confirm", () => {
  async function dictate() {
    const mic = screen.getByTestId("quick-capture-mic")
    fireEvent.pointerDown(mic, { pointerId: 1 })
    stt.state = "recording"
    // A hold, not a tap: past MIC_HOLD_THRESHOLD_MS the release transcribes.
    vi.setSystemTime(Date.now() + 400)
    await act(async () => { fireEvent.pointerUp(mic) })
  }

  // The whole point of the asymmetry. A misheard sentence must not be able to
  // spawn a session before the operator has seen it.
  it("lands the transcript in the field and posts NOTHING", async () => {
    renderBar()

    await dictate()

    expect((screen.getByTestId("quick-capture-input") as HTMLInputElement).value).toBe("the closed rail scrolls under the header")
    expect(startTodoCapture).not.toHaveBeenCalled()
    expect(screen.getByTestId("quick-capture-confirm-hint")).toBeTruthy()
  })

  it("posts once, as speech-derived, when the confirm is tapped", async () => {
    renderBar()
    await dictate()

    await act(async () => { fireEvent.click(screen.getByTestId("quick-capture-send")) })

    expect(startTodoCapture).toHaveBeenCalledTimes(1)
    expect(startTodoCapture).toHaveBeenCalledWith({
      text: "the closed rail scrolls under the header",
      speechDerived: true,
    })
  })

  it("lets the operator correct a misheard transcript before confirming", async () => {
    renderBar()
    await dictate()

    fireEvent.change(screen.getByTestId("quick-capture-input"), { target: { value: "the closed rail scrolls under the header on mobile" } })
    expect(startTodoCapture).not.toHaveBeenCalled()

    await act(async () => { fireEvent.click(screen.getByTestId("quick-capture-send")) })

    expect(startTodoCapture).toHaveBeenCalledWith({
      text: "the closed rail scrolls under the header on mobile",
      speechDerived: true,
    })
  })

  // The other half of the contract: typing is still fully autonomous.
  it("still posts a typed capture with no confirm, and not as speech-derived", async () => {
    renderBar()
    const input = await type("typed straight through")

    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }) })

    expect(screen.queryByTestId("quick-capture-confirm-hint")).toBeNull()
    expect(startTodoCapture).toHaveBeenCalledTimes(1)
    expect(startTodoCapture).toHaveBeenCalledWith({ text: "typed straight through", speechDerived: false })
  })
})
