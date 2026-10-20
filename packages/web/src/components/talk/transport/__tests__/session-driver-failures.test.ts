/**
 * What the model is told when a control does not succeed.
 *
 * Split from `session-driver-actions.test.ts`: the honesty
 * contract is its own concern, and the two together outgrew the size cap.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const authFetch = vi.fn()
vi.mock("@/lib/auth", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/auth")>()
  return { ...original, authFetch: (...args: unknown[]) => authFetch(...args) }
})

const localExecute = vi.fn()
vi.mock("@/components/talk/tools/registry", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/components/talk/tools/registry")>()
  return { ...original, executeToolCall: (...args: unknown[]) => localExecute(...args) }
})

const { createTalkDriver } = await import("../session-driver")

const operation = {
  name: "talk_comment_todo",
  description: "Add one verified comment.",
  parameters: {
    type: "object" as const,
    properties: { id: { type: "string" }, body: { type: "string" } },
    required: ["id", "body"],
    additionalProperties: false as const,
  },
  target: "gateway" as const,
  intent: "todos",
  mutability: "write" as const,
  operatorOnly: true,
  verification: "comment-reread",
}

function response(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })
}

beforeEach(() => {
  authFetch.mockReset()
  localExecute.mockReset()
})

describe("what the model is told when a control fails", () => {
  /**
   * The "no trace whatsoever" regression. A name this client's
   * manifest does not carry used to be refused here, so nothing was posted and
   * the gateway log for that window was empty — the operator was told the
   * attempt failed and no one could find out why. The gateway owns the
   * manifest, so the rejection is its call to make and its line to write.
   */
  it("reports a name its manifest does not declare to the gateway instead of dropping it", async () => {
    authFetch.mockResolvedValue(response({
      ok: false, code: "unknown-operation", error: "talk_create_todo is not in the Talk manifest.",
    }))
    const sent: Array<Record<string, unknown>> = []
    const driver = createTalkDriver({
      sessionId: "talk-1",
      manifest: { version: 1, operations: [operation] },
      send: (event) => sent.push(event),
      onState: () => {},
      onError: () => {},
    })

    driver.receive(JSON.stringify({
      type: "response.function_call_arguments.done",
      call_id: "unknown-call-1",
      name: "talk_create_todo",
      arguments: '{"title":"check the sandbox replay"}',
    }))

    await vi.waitFor(() => expect(authFetch).toHaveBeenCalledOnce())
    expect(localExecute).not.toHaveBeenCalled()
    const [path, init] = authFetch.mock.calls[0] as [string, RequestInit]
    expect(path).toBe("/api/talk/sessions/talk-1/control")
    expect(JSON.parse(String(init.body))).toMatchObject({ providerCallId: "unknown-call-1", tool: "talk_create_todo" })
    await vi.waitFor(() => expect(sent.some((event) => event.type === "conversation.item.create")).toBe(true))
    const output = sent.find((event) => event.type === "conversation.item.create")!.item as { output: string }
    expect(JSON.parse(output.output)).toMatchObject({
      ok: false, code: "unknown-operation", error: "talk_create_todo is not in the Talk manifest.",
    })
  })
  /**
   * A control that never reached the gateway is a different fact from one the
   * gateway refused, and the driver used to flatten both into one sentence —
   * so a stopped gateway sounded exactly like a rejected write.
   */
  it("tells the model why a control never reached the gateway", async () => {
    authFetch.mockRejectedValue(new Error("The gateway answered 502 for the talk session."))
    const sent: Array<Record<string, unknown>> = []
    const driver = createTalkDriver({
      sessionId: "talk-1",
      manifest: { version: 1, operations: [operation] },
      send: (event) => sent.push(event),
      onState: () => {},
      onError: () => {},
    })

    driver.receive(JSON.stringify({
      type: "response.function_call_arguments.done",
      call_id: "down-call-1",
      name: operation.name,
      arguments: '{"id":"ABC-1","body":"done"}',
    }))

    await vi.waitFor(() => expect(sent.some((event) => event.type === "conversation.item.create")).toBe(true))
    const output = sent.find((event) => event.type === "conversation.item.create")!.item as { output: string }
    expect(JSON.parse(output.output)).toEqual({
      ok: false,
      code: "transport-failed",
      error: "The Talk control could not reach the gateway: The gateway answered 502 for the talk session.",
    })
  })
  it("refuses to pass off a gateway body that never says whether it succeeded", async () => {
    authFetch.mockResolvedValue(response({}))
    const sent: Array<Record<string, unknown>> = []
    const driver = createTalkDriver({
      sessionId: "talk-1",
      manifest: { version: 1, operations: [operation] },
      send: (event) => sent.push(event),
      onState: () => {},
      onError: () => {},
    })

    driver.receive(JSON.stringify({
      type: "response.function_call_arguments.done",
      call_id: "empty-answer-1",
      name: operation.name,
      arguments: '{"id":"ABC-1","body":"done"}',
    }))

    await vi.waitFor(() => expect(sent.some((event) => event.type === "conversation.item.create")).toBe(true))
    const output = sent.find((event) => event.type === "conversation.item.create")!.item as { output: string }
    expect(JSON.parse(output.output)).toEqual({
      ok: false,
      code: "malformed-answer",
      error: "The gateway's answer to talk_comment_todo did not say whether it succeeded.",
    })
  })
  it("preserves the real reason when a verified control effect fails", async () => {
    authFetch.mockResolvedValue(response({
      ok: true,
      verified: true,
      receiptId: "effect-receipt-1",
      replayed: false,
      operation: operation.name,
      data: {},
      evidence: {},
      uiEffect: { navigate: "/todos/ABC-1" },
    }))
    const sent: Array<Record<string, unknown>> = []
    const driver = createTalkDriver({
      sessionId: "talk-1",
      manifest: { version: 1, operations: [operation] },
      send: (event) => sent.push(event),
      onState: () => {},
      onError: () => {},
      applyUiEffect: async () => { throw new Error("The selected Todo could not be shown.") },
    })

    driver.receive(JSON.stringify({
      type: "response.function_call_arguments.done",
      call_id: "effect-call-1",
      name: operation.name,
      arguments: '{"id":"ABC-1","body":"done"}',
    }))

    await vi.waitFor(() => expect(sent.some((event) => event.type === "conversation.item.create")).toBe(true))
    const output = sent.find((event) => event.type === "conversation.item.create")!.item as { output: string }
    expect(JSON.parse(output.output)).toEqual({
      ok: false,
      code: "tool-failed",
      error: "The selected Todo could not be shown.",
    })
  })
  /**
   * Found by the live sandbox replay: with the gateway killed mid-session, a
   * spoken turn failed while persisting the operator's utterance — before the
   * transport guard — so the model was handed a bare "Failed to fetch" with no
   * subject, while a typed turn got the full sentence.
   */
  it("names the gateway even when the operator's utterance is what failed to reach it", async () => {
    authFetch.mockRejectedValue(new Error("Failed to fetch"))
    const sent: Array<Record<string, unknown>> = []
    const driver = createTalkDriver({
      sessionId: "talk-1", browserInstanceId: "browser-1", credentialGeneration: 1,
      manifest: { version: 1, operations: [operation] },
      send: (event) => sent.push(event), onState: () => {}, onError: () => {},
    })

    driver.receive(JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      event_id: "voice-event-1", item_id: "voice-item-1", transcript: "make me a todo",
    }))
    driver.receive(JSON.stringify({
      type: "response.function_call_arguments.done",
      call_id: "down-call-2", name: operation.name, arguments: '{"id":"ABC-1","body":"done"}',
    }))

    await vi.waitFor(() => expect(sent.some((event) => event.type === "conversation.item.create")).toBe(true))
    const output = sent.find((event) => event.type === "conversation.item.create")!.item as { output: string }
    expect(JSON.parse(output.output)).toEqual({
      ok: false,
      code: "transport-failed",
      error: "The Talk control could not reach the gateway: Failed to fetch",
    })
  })
})
