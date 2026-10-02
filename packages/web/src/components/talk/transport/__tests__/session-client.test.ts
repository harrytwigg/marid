import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const authFetch = vi.fn()

vi.mock("@/lib/auth", () => ({
  authFetch: (...args: unknown[]) => authFetch(...args),
}))

const {
  HEARTBEAT_INTERVAL_MS,
  TalkSessionMissingError,
  VoiceUnconfiguredError,
  closeTalkSession,
  acknowledgeTalkProactiveCue,
  getTalkSession,
  openTalkSession,
  parkTalkSession,
  postTalkControlCall,
  postTalkTurn,
  resumeTalkSession,
  startTalkHeartbeat,
} = await import("../session-client")
const { emptyTalkUsage } = await import("../usage-delta")

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

const MANIFEST = {
  version: 1,
  operations: [{
    name: "read_todo",
    description: "Read one Todo.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    target: "gateway",
    intent: "todos",
    mutability: "read",
    operatorOnly: false,
    verification: "todo-reread",
  }],
} as const

const OPENED = { id: "talk-1", token: "ephemeral-secret", expiresAt: 1_700_000_600, model: "gpt-realtime-2.1", manifest: MANIFEST }

beforeEach(() => {
  authFetch.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("opening a session", () => {
  it("posts the collection once and hands back the credential it minted", async () => {
    authFetch.mockResolvedValue(json(OPENED, 201))

    const opened = await openTalkSession()

    expect(opened).toMatchObject({ id: "talk-1", token: "ephemeral-secret" })
    expect(authFetch).toHaveBeenCalledTimes(1)
    const [url, init] = authFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("/api/talk/sessions")
    expect(init.method).toBe("POST")
  })

  // The gateway attributes this one rather than describing it, so the caller can
  // offer setup. Matching on the sentence would make that a string comparison.
  it("reports an unconfigured refusal as its own kind of failure", async () => {
    authFetch.mockResolvedValue(
      json({ error: "Voice is not available.", reason: "unconfigured", detail: "realtime.provider is not set" }, 503),
    )

    await expect(openTalkSession()).rejects.toThrow(VoiceUnconfiguredError)
  })

  it("reports the gateway's own words when the provider refuses to mint", async () => {
    authFetch.mockResolvedValue(
      json({ error: "The realtime provider refused to issue a session credential." }, 502),
    )

    await expect(openTalkSession()).rejects.toThrow("refused to issue a session credential")
  })

  it("still says something useful when the failure carries no message at all", async () => {
    authFetch.mockResolvedValue(new Response("<html>gateway down</html>", { status: 502 }))

    await expect(openTalkSession()).rejects.toThrow("502")
  })

  it("refuses a response that names no session, rather than opening against undefined", async () => {
    authFetch.mockResolvedValue(json({ token: "ephemeral-secret" }, 201))

    await expect(openTalkSession()).rejects.toThrow(/id/)
  })
})

describe("the rest of the lifecycle", () => {
  it("discovers a resumable session with a read that cannot mint a credential", async () => {
    authFetch.mockResolvedValue(json({
      id: "talk-1",
      state: "parked",
      browserInstanceId: "browser-1",
      credentialGeneration: 4,
      brief: "standing brief",
      manifest: MANIFEST,
      proactiveCues: [{
        receiptId: "receipt-1", talkSessionId: "talk-1", topicId: null,
        disposition: "quiet", urgency: "routine", summary: "A Todo changed.", uiEffect: null,
      }],
    }))

    const session = await getTalkSession("talk-1")

    expect(session).toMatchObject({
      id: "talk-1",
      state: "parked",
      credentialGeneration: 4,
      proactiveCues: [{ receiptId: "receipt-1" }],
    })
    const [url, init] = authFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("/api/talk/sessions/talk-1")
    expect(init.method).toBe("GET")
  })

  it("acknowledges a proactive receipt with a bounded session-scoped write", async () => {
    authFetch.mockResolvedValue(json({ receipt: { id: "receipt-1", acknowledgedAt: 123 } }))

    await acknowledgeTalkProactiveCue("talk-1", "receipt-1", "interrupted")

    const [url, init] = authFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("/api/talk/proactive/talk-1/ack")
    expect(JSON.parse(String(init.body))).toEqual({ receiptId: "receipt-1", outcome: "interrupted" })
  })

  it("names a missing resumable candidate so the caller can fall back safely", async () => {
    authFetch.mockResolvedValue(json({ error: "Talk session talk-1 does not exist" }, 404))

    await expect(getTalkSession("talk-1")).rejects.toThrow(TalkSessionMissingError)
  })

  it("posts one provider call to the session's universal control route", async () => {
    authFetch.mockResolvedValue(json({ ok: true, verified: true, operation: "read_todo", data: {}, evidence: {}, uiEffect: null }))

    await postTalkControlCall("talk-1", {
      providerCallId: "call-1",
      providerItemId: "item-1",
      tool: "read_todo",
      arguments: '{"id":"ABC-1"}',
    })

    const [url, init] = authFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("/api/talk/sessions/talk-1/control")
    expect(JSON.parse(String(init.body))).toEqual({
      providerCallId: "call-1",
      providerItemId: "item-1",
      tool: "read_todo",
      arguments: '{"id":"ABC-1"}',
    })
  })

  it("retries one lost control response with the same provider identity", async () => {
    authFetch
      .mockRejectedValueOnce(new TypeError("network reset"))
      .mockResolvedValueOnce(json({
        ok: true, verified: true, receiptId: "receipt-1", replayed: true,
        operation: "read_todo", data: {}, evidence: {}, uiEffect: null,
      }))
    const call = { providerCallId: "call-retry", tool: "read_todo", arguments: '{"id":"ABC-1"}' }

    await expect(postTalkControlCall("talk-1", call)).resolves.toMatchObject({ ok: true, replayed: true })

    expect(authFetch).toHaveBeenCalledTimes(2)
    expect((authFetch.mock.calls as Array<[string, RequestInit]>).map(([, init]) => init.body))
      .toEqual([JSON.stringify(call), JSON.stringify(call)])
  })

  it("closes with a DELETE on the session itself", async () => {
    authFetch.mockResolvedValue(json({ id: "talk-1", state: "closed" }))

    await closeTalkSession("talk-1")

    const [url, init] = authFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("/api/talk/sessions/talk-1")
    expect(init.method).toBe("DELETE")
    // Sent from a page that may be going away, so the browser is asked to finish it.
    expect(init.keepalive).toBe(true)
  })

  it("parks and resumes, and a resume brings back a credential that outlives the old one", async () => {
    authFetch.mockResolvedValueOnce(json({ id: "talk-1", state: "parked" }))
    authFetch.mockResolvedValueOnce(json({ token: "second-secret", expiresAt: 1_700_001_200 }))

    await parkTalkSession("talk-1")
    const resumed = await resumeTalkSession("talk-1")

    expect(authFetch.mock.calls[0]![0]).toBe("/api/talk/sessions/talk-1/park")
    expect((authFetch.mock.calls[0]![1] as RequestInit).keepalive).toBe(true)
    expect(authFetch.mock.calls[1]![0]).toBe("/api/talk/sessions/talk-1/resume")
    expect(resumed).toEqual({ token: "second-secret", expiresAt: 1_700_001_200 })
  })

  it("posts a turn's usage and what was said", async () => {
    authFetch.mockResolvedValue(json({ spendUsd: 0.02 }))

    await postTalkTurn("talk-1", { ...emptyTalkUsage(), inputAudioTokens: 900 }, "open ABC-1")

    const [url, init] = authFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("/api/talk/sessions/talk-1/turn")
    expect(JSON.parse(String(init.body))).toEqual({
      usage: { ...emptyTalkUsage(), inputAudioTokens: 900 },
      transcript: "open ABC-1",
    })
  })

  it("posts bounded visual receipts with the turn that paid for them", async () => {
    authFetch.mockResolvedValue(json({ spendUsd: 0.02 }))
    const receipt = {
      requestKey: "item-user-1",
      contextRevision: 9,
      reason: "org-chart-spatial-layout",
      bytes: 3,
      width: 900,
      height: 600,
      estimatedImageTokens: 765,
      latencyMs: 24,
    }

    await postTalkTurn("talk-1", emptyTalkUsage(), "The left node is Build.", [receipt])

    const [, init] = authFetch.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toMatchObject({ visualReceipts: [receipt] })
  })

  it("posts provider response evidence for durable assistant-message dedupe", async () => {
    authFetch.mockResolvedValue(json({ spendUsd: 0.02 }))

    await postTalkTurn("talk-1", emptyTalkUsage(), "Done.", [], {
      providerResponseId: "response-1",
      providerItemId: "assistant-item-1",
    })

    const [, init] = authFetch.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toMatchObject({
      transcript: "Done.",
      providerResponseId: "response-1",
      providerItemId: "assistant-item-1",
    })
  })

  it("escapes an id rather than letting it shape the path", async () => {
    authFetch.mockResolvedValue(json({ id: "x", state: "closed" }))

    await closeTalkSession("talk 1/../other")

    expect(authFetch.mock.calls[0]![0]).toBe("/api/talk/sessions/talk%201%2F..%2Fother")
  })
})

describe("the heartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    authFetch.mockResolvedValue(json({ id: "talk-1", state: "live" }))
  })

  it("is three times slower than the gateway's ninety-second reaper", () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(30_000)
  })

  it("beats on the interval and not before it", async () => {
    startTalkHeartbeat("talk-1")

    expect(authFetch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS)
    expect(authFetch).toHaveBeenCalledTimes(1)
    expect(authFetch.mock.calls[0]![0]).toBe("/api/talk/sessions/talk-1/heartbeat")
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 2)
    expect(authFetch).toHaveBeenCalledTimes(3)
  })

  it("stops for good once the session is closed", async () => {
    const stop = startTalkHeartbeat("talk-1")

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS)
    stop()
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 5)

    expect(authFetch).toHaveBeenCalledTimes(1)
  })

  it("keeps beating when one beat fails, because the next one is what re-attaches", async () => {
    authFetch.mockRejectedValueOnce(new Error("offline"))
    startTalkHeartbeat("talk-1")

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 2)

    expect(authFetch).toHaveBeenCalledTimes(2)
  })
})
