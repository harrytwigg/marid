import { beforeEach, describe, expect, it, vi } from "vitest"

const authFetch = vi.fn()
vi.mock("@/lib/auth", () => ({ authFetch: (...args: unknown[]) => authFetch(...args) }))

const { openTalkSession, resumeTalkSession } = await import("../session-client")

const MANIFEST = {
  version: 1,
  operations: [{
    name: "read_todo",
    description: "Read one Todo.",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    target: "gateway",
    intent: "todos",
    mutability: "read",
    operatorOnly: false,
    verification: "todo-reread",
  }],
} as const

const json = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { "Content-Type": "application/json" },
})

beforeEach(() => {
  authFetch.mockReset()
  localStorage.clear()
})

/**
 * Noise reduction is the gateway's to decide, from `realtime.noiseReduction`.
 *
 * It used to be a browser setting the page sent on every open — and because
 * that setting always had a value, it always won, so the configured field
 * could never take effect. These tests pin the fold: the browser asks for
 * nothing and reports what it was given.
 */
describe("who decides the Talk audio profile", () => {
  it("does not send a noise-reduction preference when opening a session", async () => {
    localStorage.setItem("hundredfold-settings", JSON.stringify({ talkMicrophone: "near_field" }))
    authFetch.mockResolvedValue(json({ id: "talk-1", token: "secret", manifest: MANIFEST }))

    await openTalkSession()

    const [, init] = authFetch.mock.calls[0] as [string, RequestInit]
    // A stale browser-local copy must not travel, let alone override config.
    expect(JSON.parse(String(init.body))).not.toHaveProperty("noiseReduction")
  })

  it("reports the profile the gateway chose, so the session knows what it got", async () => {
    authFetch.mockResolvedValue(
      json({ id: "talk-1", token: "secret", manifest: MANIFEST, noiseReduction: "near_field" }),
    )

    const opened = await openTalkSession()

    expect(opened.noiseReduction).toBe("near_field")
  })

  it("falls back to far-field only when the gateway reports nothing usable", async () => {
    authFetch.mockResolvedValue(
      json({ id: "talk-1", token: "secret", manifest: MANIFEST, noiseReduction: "studio" }),
    )

    const opened = await openTalkSession()

    expect(opened.noiseReduction).toBe("far_field")
  })

  it("asks for nothing on resume either — the config has not moved", async () => {
    localStorage.setItem("hundredfold-settings", JSON.stringify({ talkMicrophone: "near_field" }))
    authFetch.mockResolvedValue(json({ token: "fresh", expiresAt: 99 }))

    await resumeTalkSession("talk-1")

    const [, init] = authFetch.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({})
  })
})
