/**
 * The overlay, mounted the way React 19 mounts it in development: twice.
 *
 * StrictMode runs every effect, tears it down, and runs it again. If any of
 * that opened a connection or subscribed a second handler to the data channel,
 * one spoken task would run its tool twice — so the whole path is exercised
 * here rather than the hook alone, because it is the mounting that is on trial.
 */
import { act, render, screen, waitFor } from "@testing-library/react"
import { StrictMode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULTS, type HundredfoldSettings } from "@/lib/settings"

vi.mock("@/hooks/use-gateway", () => ({ useGateway: () => ({ subscribe: () => () => {} }) }))

const authFetch = vi.fn()
vi.mock("@/lib/auth", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/auth")>()
  return { ...original, authFetch: (...args: unknown[]) => authFetch(...args) }
})

const addWorkItemComment = vi.fn()
vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api")>()
  return { ...original, api: { ...original.api, addWorkItemComment: (...args: unknown[]) => addWorkItemComment(...args) } }
})

const stored = vi.hoisted(() => ({ settings: {} as HundredfoldSettings }))
vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings: stored.settings }) }))

// jsdom has no compositor and no pointer capture, and the sphere is a canvas
// with a drag gesture on it. What this test needs from the orb is the press.
vi.mock("../talk-orb", () => ({
  TalkOrb: ({ onToggle }: { onToggle?: () => void }) => (
    <button type="button" data-testid="orb" onClick={() => onToggle?.()} />
  ),
}))

vi.mock("../transport/webrtc-connection", async () => ({
  connectRealtime: (await import("../transport/__tests__/fake-connection")).connect,
}))

const { TalkOrbOverlay } = await import("../talk-orb-overlay")
const { clearResumableTalkSession, setTalkSessionId } = await import("../talk-session-store")
const { FakeConnection, connect } = await import("../transport/__tests__/fake-connection")
const { browserControlFixture } = await import("../transport/__tests__/control-fixture")

const OPENED = {
  id: "talk-1",
  token: "secret-1",
  expiresAt: 1_700_000_600,
  model: "gpt-realtime-2.1",
  manifest: browserControlFixture(),
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

const TOOL_CALL = JSON.stringify({
  type: "response.function_call_arguments.done",
  call_id: "call-1",
  name: "talk_comment_todo",
  arguments: JSON.stringify({ id: "ABC-1", body: "on it" }),
})

/** The overlay, opened by the operator's press, with its one live connection. */
async function activate() {
  const mounted = render(
    <StrictMode>
      <TalkOrbOverlay />
    </StrictMode>,
  )
  // A cold dynamic import of the transport chunk costs more than waitFor's
  // one-second default, which is a budget for a render.
  await waitFor(() => expect(screen.queryByTestId("orb")).not.toBeNull(), { timeout: 15_000 })
  await act(async () => screen.getByTestId("orb").click())
  await waitFor(() => expect(FakeConnection.opened).toHaveLength(1))
  const connection = FakeConnection.opened[0]!
  await waitFor(() => expect(connection.sent.some((event) => event.type === "session.update")).toBe(true))
  return { mounted, connection }
}

beforeEach(() => {
  stored.settings = { ...DEFAULTS, talkOrb: true }
  authFetch.mockReset()
  authFetch.mockImplementation(async (url: string, init: RequestInit = {}) => {
    if (url === "/api/talk/config") return json({ configured: true, provider: "openai", providers: ["openai"] })
    if (url === "/api/talk/sessions" && init.method === "POST") return json(OPENED, 201)
    return json({ ok: true })
  })
  addWorkItemComment.mockReset()
  addWorkItemComment.mockResolvedValue({ comment: { id: "c-1" } })
  connect.mockClear()
  FakeConnection.opened = []
  act(() => setTalkSessionId(null))
  clearResumableTalkSession()
})

describe("TalkOrbOverlay under StrictMode", () => {
  it("opens one connection and runs one tool call once for one frame", async () => {
    const { connection } = await activate()

    await act(async () => connection.deliver(TOOL_CALL))

    await waitFor(() => expect(addWorkItemComment).toHaveBeenCalledTimes(1))
    expect(connect).toHaveBeenCalledTimes(1)
    expect(connection.sent.filter((event) => event.type === "response.create")).toHaveLength(1)
    expect(connection.sent.filter((event) => event.type === "conversation.item.create")).toHaveLength(1)
  })

  it("closes its connection on the way out, and a frame after that reaches nothing", async () => {
    const { mounted, connection } = await activate()
    await act(async () => connection.deliver(TOOL_CALL))
    await waitFor(() => expect(addWorkItemComment).toHaveBeenCalledTimes(1))
    const settled = connection.sent.length

    mounted.unmount()
    await act(async () => connection.deliver(TOOL_CALL))

    expect(connection.closes).toBe(1)
    expect(addWorkItemComment).toHaveBeenCalledTimes(1)
    expect(connection.sent).toHaveLength(settled)
  })
})
