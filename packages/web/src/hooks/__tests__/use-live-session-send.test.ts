/**
 * useLiveSession — the send lifecycle: the optimistic insert, the moment the
 * server acknowledges it, and a failure that lands on the message that failed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act } from "@testing-library/react"

const getSession = vi.fn()
const getSessionMessages = vi.fn()
vi.mock("@/lib/api", () => ({
  api: {
    getSession: (id: string, options?: unknown) => getSession(id, options),
    getSessionMessages: (id: string, options: unknown) => getSessionMessages(id, options),
  },
}))

import { __clearLiveSessionSnapshotCacheForTests, useLiveSession } from "../use-live-session"
import type { GatewayEvent, GatewayEventListener } from "@hundredfold/gateway-events"

/** A manual gateway subscribe that lets the test emit WS events. */
function makeBus() {
  let listener: GatewayEventListener | null = null
  const subscribe = (fn: GatewayEventListener) => {
    listener = fn
    return () => { listener = null }
  }
  const emit = (event: string, payload: unknown) => listener?.({ event, payload } as GatewayEvent)
  return { subscribe, emit }
}

beforeEach(() => {
  getSession.mockReset()
  getSessionMessages.mockReset()
  __clearLiveSessionSnapshotCacheForTests()
})

describe("useLiveSession send lifecycle", () => {
  it("beginSend puts the user message on screen in the same frame, pending", async () => {
    getSession.mockResolvedValue({ status: "idle", messages: [] })
    const { subscribe } = makeBus()
    const { result } = renderHook(() => useLiveSession("s1", { subscribe }))
    await act(async () => { await Promise.resolve() })

    // No awaited round-trip between the call and the assertion: the bubble is
    // there the moment beginSend returns, or the transition has nothing to run on.
    act(() => {
      result.current.beginSend({ id: "u1", role: "user", content: "x", timestamp: 1 })
    })
    expect(result.current.messages.map((m) => m.id)).toEqual(["u1"])
    expect(result.current.messages[0].sendState).toBe("pending")
    expect(result.current.loading).toBe(true)
  })

  it("settles the pending bubble on the first frame of the turn", async () => {
    getSession.mockResolvedValue({ status: "idle", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() => useLiveSession("s1", { subscribe }))
    await act(async () => { await Promise.resolve() })

    act(() => {
      result.current.beginSend({ id: "u1", role: "user", content: "x", timestamp: 1 })
    })
    act(() => { emit("session:delta", { sessionId: "s1", type: "text", content: "hi" }) })
    expect(result.current.messages[0].sendState).toBeUndefined()
  })

  it("failSend marks the user's own message failed and appends no assistant row", async () => {
    getSession.mockResolvedValue({ status: "idle", messages: [] })
    const { subscribe } = makeBus()
    const { result } = renderHook(() => useLiveSession("s1", { subscribe }))
    await act(async () => { await Promise.resolve() })

    act(() => {
      result.current.beginSend({ id: "u1", role: "user", content: "x", timestamp: 1 })
    })
    expect(result.current.loading).toBe(true)

    act(() => { result.current.failSend("nope") })
    expect(result.current.loading).toBe(false)
    expect(result.current.messages.map((m) => m.role)).toEqual(["user"])
    expect(result.current.messages[0].sendState).toBe("failed")
    expect(result.current.messages[0].sendError).toBe("nope")
  })
})
