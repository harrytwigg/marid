import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { GatewayEvent, GatewayEventListener } from "@jinn/gateway-events"
import type { TodoCaptureWire } from "@/lib/api"

/**
 * The capture bar's contract with the wire, on the TEXT path.
 *
 * Two properties matter more than the rest and are asserted directly: a capture
 * posts exactly once (it spawns a session and spends money), and the strip
 * never shows a stage the server has not reported. The voice path and its one
 * confirm live in capture-bar-voice.test.tsx — same bar, different contract.
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

afterEach(() => { listener = undefined })

describe("QuickCaptureBar — the text path", () => {
  it("is one field and one send, with no form fields", () => {
    renderBar()

    expect(screen.getByTestId("quick-capture-input")).toBeTruthy()
    expect(screen.queryByLabelText(/department/i)).toBeNull()
    expect(screen.queryByLabelText(/priority/i)).toBeNull()
    expect(screen.queryByLabelText(/assignee/i)).toBeNull()
  })

  it("posts on Enter, with speechDerived false — the typed path needs no confirm", async () => {
    renderBar()
    const input = await type("the closed rail scrolls under the header on mobile")

    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }) })

    expect(startTodoCapture).toHaveBeenCalledTimes(1)
    expect(startTodoCapture).toHaveBeenCalledWith({
      text: "the closed rail scrolls under the header on mobile",
      speechDerived: false,
    })
  })

  // A capture spawns a session. Two Shapers from one intent is real money and a
  // duplicate Todo, so this is a correctness property rather than polish.
  it("posts once and only once however hard the operator presses Enter", async () => {
    renderBar()
    const input = await type("dispatch me exactly once")

    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" })
      fireEvent.keyDown(input, { key: "Enter" })
      fireEvent.keyDown(input, { key: "Enter" })
    })
    await act(async () => { fireEvent.click(screen.getByTestId("quick-capture-send")) })

    expect(startTodoCapture).toHaveBeenCalledTimes(1)
  })

  it("does not post an empty capture", async () => {
    renderBar()
    const input = await type("   ")

    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }) })

    expect(startTodoCapture).not.toHaveBeenCalled()
  })

  it("renders only the stages the wire has reported, in order", async () => {
    renderBar()
    const input = await type("a capture in flight")

    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }) })

    // The server said `starting`; nothing beyond it may be drawn.
    expect(screen.getByTestId("capture-step-captured")).toBeTruthy()
    expect(screen.getByTestId("capture-step-starting")).toBeTruthy()
    expect(screen.queryByTestId("capture-step-shaping")).toBeNull()
    expect(screen.queryByTestId("capture-step-created")).toBeNull()
    expect(screen.queryByTestId("capture-step-dispatching")).toBeNull()
    expect(screen.queryByTestId("capture-step-routed")).toBeNull()

    getTodoCapture.mockResolvedValue(wire({ stage: "created", workItemId: "PLA-9", workItemTitle: "Shaped" }))
    await act(async () => { listener?.("todo-capture:stage", { captureId: "cap-1", stage: "created", workItemId: "PLA-9" }) })

    await waitFor(() => expect(screen.getByTestId("capture-step-created")).toBeTruthy())
    expect(screen.getByTestId("capture-step-shaping")).toBeTruthy()
    expect(screen.getByTestId("capture-step-created").textContent).toContain("PLA-9 created")
    expect(screen.queryByTestId("capture-step-routed")).toBeNull()

    const order = Array.from(screen.getByTestId("capture-pipeline").querySelectorAll("li"))
      .map((li) => li.getAttribute("data-testid"))
    expect(order).toEqual([
      "capture-step-captured",
      "capture-step-starting",
      "capture-step-shaping",
      "capture-step-created",
    ])
  })

  it("names the employee on the terminal line when nothing covered it", async () => {
    renderBar()
    const input = await type("a capture nothing covers")
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }) })

    getTodoCapture.mockResolvedValue(wire({
      stage: "routed",
      workItemId: "PLA-9",
      routedTo: { kind: "employee", employee: "route-worker", sessionId: "s-2" },
    }))
    await act(async () => { listener?.("todo-capture:stage", { captureId: "cap-1", stage: "routed", workItemId: "PLA-9" }) })

    await waitFor(() => expect(screen.getByTestId("capture-step-routed").textContent).toContain("Delegated to route-worker"))
  })

  // A dedupe is a different ending, not a broken one. It gets its own line, in
  // the ordinary text colour rather than the error slot, and it names the Todo
  // the operator's sentence actually reached.
  it("names the existing Todo on its own terminal line when the capture restated one", async () => {
    renderBar()
    const input = await type("the closed rail scrolls under the header on mobile")
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }) })

    getTodoCapture.mockResolvedValue(wire({
      stage: "landed",
      workItemId: "PLA-4",
      workItemTitle: "Collapsed rail scrolls under the header",
    }))
    await act(async () => { listener?.("todo-capture:stage", { captureId: "cap-1", stage: "landed", workItemId: "PLA-4" }) })

    await waitFor(() => expect(screen.getByTestId("capture-landed").textContent).toContain("Already tracked as PLA-4"))
    expect(screen.queryByTestId("capture-error")).toBeNull()
  })

  // The honesty contract, on the branch where it is easiest to break: a landing
  // created nothing, dispatched nothing and routed nothing, so none of those
  // rungs may appear under it.
  it("claims no stage a landing never reached", async () => {
    renderBar()
    const input = await type("a capture that restates something")
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }) })

    getTodoCapture.mockResolvedValue(wire({ stage: "landed", workItemId: "PLA-4" }))
    await act(async () => { listener?.("todo-capture:stage", { captureId: "cap-1", stage: "landed", workItemId: "PLA-4" }) })

    await waitFor(() => expect(screen.getByTestId("capture-landed")).toBeTruthy())
    for (const step of ["created", "dispatching", "routed"]) {
      expect(screen.queryByTestId(`capture-step-${step}`)).toBeNull()
    }
  })

  it("shows the server's failure text verbatim, and no stage past the failing one", async () => {
    const reason = 'engine "codex" not available; change the Todo Shaper engine override and try again'
    renderBar()
    const input = await type("a capture that will fail")
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }) })

    getTodoCapture.mockResolvedValue(wire({ stage: "failed", error: reason }))
    await act(async () => { listener?.("todo-capture:stage", { captureId: "cap-1", stage: "failed", workItemId: null }) })

    await waitFor(() => expect(screen.getByTestId("capture-error").textContent).toContain(reason))
    expect(screen.queryByTestId("capture-step-shaping")).toBeNull()
  })

  it("shows a refused POST's reason rather than a generic failure", async () => {
    startTodoCapture.mockRejectedValue(new Error("text is 4001 characters; the cap is 4000."))
    renderBar()
    const input = await type("far too long")

    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }) })

    await waitFor(() => expect(screen.getByTestId("capture-error").textContent).toContain("the cap is 4000"))
  })
})
