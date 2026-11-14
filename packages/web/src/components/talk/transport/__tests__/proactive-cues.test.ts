import type { GatewayEvent } from "@hundredfold/gateway-events"
import { describe, expect, it, vi } from "vitest"
import { createProactiveCueReceiver } from "../proactive-cues"

function frame(overrides: Partial<Extract<GatewayEvent, { event: "talk:proactive-cue" }>["payload"]> = {}): GatewayEvent {
  return {
    event: "talk:proactive-cue",
    payload: {
      receiptId: "receipt-1",
      talkSessionId: "talk-1",
      topicId: null,
      disposition: "quiet",
      urgency: "routine",
      summary: "The list changed.",
      uiEffect: { type: "refresh", target: "todos" },
      ...overrides,
    },
  }
}

describe("proactive cues at the browser boundary", () => {
  it("applies a quiet cue without speaking or rendering anything", async () => {
    const speak = vi.fn()
    const apply = vi.fn().mockResolvedValue(undefined)
    const acknowledge = vi.fn().mockResolvedValue(undefined)
    const receive = createProactiveCueReceiver({ sessionId: () => "talk-1", speak, apply, acknowledge })

    await receive(frame())

    expect(apply).toHaveBeenCalledWith({ invalidate: ["todos"] })
    expect(speak).not.toHaveBeenCalled()
    expect(acknowledge).toHaveBeenCalledWith("talk-1", "receipt-1", "completed")
  })

  it("speaks one matching urgent receipt and drops replay and foreign-session frames", async () => {
    const acknowledge = vi.fn().mockResolvedValue(undefined)
    const speak = vi.fn().mockImplementation((_summary, _receiptId, settled) => {
      settled("completed")
      return true
    })
    const apply = vi.fn().mockResolvedValue(undefined)
    const receive = createProactiveCueReceiver({ sessionId: () => "talk-1", speak, apply, acknowledge })
    const urgent = frame({ disposition: "spoken", urgency: "urgent", uiEffect: null })

    await receive(urgent)
    await receive(urgent)
    await receive(frame({ receiptId: "receipt-2", talkSessionId: "talk-other", disposition: "spoken", urgency: "urgent" }))

    expect(speak).toHaveBeenCalledTimes(1)
    expect(speak).toHaveBeenCalledWith("The list changed.", "receipt-1", expect.any(Function))
    expect(apply).not.toHaveBeenCalled()
    expect(acknowledge).toHaveBeenCalledWith("talk-1", "receipt-1", "completed")
  })

  it("maps a highlight onto the existing page instead of a Talk overlay", async () => {
    const apply = vi.fn().mockResolvedValue(undefined)
    const receive = createProactiveCueReceiver({
      sessionId: () => "talk-1",
      speak: vi.fn(),
      apply,
      acknowledge: vi.fn().mockResolvedValue(undefined),
    })

    await receive(frame({ uiEffect: { type: "highlight", target: "blocked-todo" } }))

    expect(apply).toHaveBeenCalledWith({ focus: "blocked-todo" })
  })

  it("keeps an urgent receipt pending when no provider attachment can accept it", async () => {
    const acknowledge = vi.fn()
    const receive = createProactiveCueReceiver({
      sessionId: () => "talk-1",
      speak: vi.fn().mockReturnValue(false),
      apply: vi.fn().mockResolvedValue(undefined),
      acknowledge,
    })

    await receive(frame({ disposition: "spoken", urgency: "urgent", uiEffect: null }))

    expect(acknowledge).not.toHaveBeenCalled()
  })
})
