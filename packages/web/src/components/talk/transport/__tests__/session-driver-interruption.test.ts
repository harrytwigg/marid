import { beforeEach, describe, expect, it, vi } from "vitest"
import type { InterruptionTelemetry } from "../false-start-recovery"

const authFetch = vi.fn()
vi.mock("@/lib/auth", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/auth")>()
  return { ...original, authFetch: (...args: unknown[]) => authFetch(...args) }
})

const { createTalkDriver } = await import("../session-driver")
const { browserControlFixture } = await import("./control-fixture")

import {
  event,
  outputCleared,
  outputStarted,
  responseCreated,
  responseDone,
  speechStarted,
  speechStopped,
  transcript,
} from "./interruption-fixture"

function driver() {
  const sent: Array<Record<string, unknown>> = []
  const states: string[] = []
  const interruptions: InterruptionTelemetry[] = []
  const built = createTalkDriver({
    sessionId: "talk-1",
    manifest: browserControlFixture(),
    send: (frame) => { sent.push(frame) },
    onState: (state) => { states.push(state) },
    onError: () => {},
    onInterruption: (frame) => { interruptions.push(frame) },
  })
  return {
    driver: built,
    requests: () => sent.filter((frame) => frame.type === "response.create"),
    cancels: () => sent.filter((frame) => frame.type === "response.cancel"),
    states,
    interruptions,
  }
}

beforeEach(() => {
  authFetch.mockReset()
  authFetch.mockResolvedValue(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }))
})

describe("provider-owned interruption and false-start recovery", () => {
  it("leaves provider VAD as the only cancellation path", () => {
    const talk = driver()
    talk.driver.receive(responseCreated("response-1"))
    talk.driver.receive(event("response.output_audio_transcript.delta", { delta: "Hello" }))
    talk.driver.receive(speechStarted("item-user-1", 1_000))
    talk.driver.receive(speechStarted("item-user-1", 1_000))

    expect(talk.cancels()).toHaveLength(0)
    expect(talk.states.at(-1)).toBe("interrupted")

    talk.driver.receive(speechStopped("item-user-1", 1_300))
    expect(talk.states.at(-1)).toBe("listening")
  })

  it("does not call ordinary listening an interruption", () => {
    const talk = driver()

    talk.driver.receive(speechStarted("item-user-1", 1_000))

    expect(talk.states).not.toContain("interrupted")
    expect(talk.states.at(-1)).toBe("user_speaking")
  })

  it("continues exactly once after correlated short empty speech", () => {
    const talk = driver()
    talk.driver.receive(responseCreated("response-1"))
    talk.driver.receive(speechStarted("item-user-1", 1_000))
    talk.driver.receive(responseDone("response-1"))
    talk.driver.receive(outputCleared("response-1"))
    talk.driver.receive(speechStopped("item-user-1", 1_240))
    talk.driver.receive(transcript("item-user-1", ""))
    talk.driver.receive(speechStopped("item-user-1", 1_240))
    talk.driver.receive(transcript("item-user-1", ""))

    expect(talk.cancels()).toHaveLength(0)
    expect(talk.requests()).toEqual([{
      type: "response.create",
      response: { instructions: expect.stringMatching(/continue.+last spoken boundary/i) },
    }])
    expect(talk.interruptions).toEqual([{
      kind: "speech_interruption",
      vadType: "server_vad",
      cancelledBy: "provider",
      recovered: true,
      speechMs: 240,
    }])
  })

  it("accepts a bounded empty false start and ignores orphan frames", () => {
    const talk = driver()
    expect(() => {
      talk.driver.receive(outputCleared())
      talk.driver.receive(speechStopped())
    }).not.toThrow()
    talk.driver.receive(responseCreated("response-1"))
    talk.driver.receive(speechStarted("item-user-1", 1_000))
    talk.driver.receive(responseDone("response-1"))
    talk.driver.receive(outputCleared("response-1"))
    talk.driver.receive(speechStopped("item-user-1", 1_600))
    talk.driver.receive(transcript("item-user-1", "   "))

    expect(talk.requests()).toHaveLength(1)
    expect(talk.interruptions).toEqual([expect.objectContaining({ recovered: true, speechMs: 600 })])
  })

  it("fails closed without timing, truncation, or transcription", () => {
    const noTiming = driver()
    noTiming.driver.receive(responseCreated("response-1"))
    noTiming.driver.receive(speechStarted("item-user-1"))
    noTiming.driver.receive(responseDone("response-1"))
    noTiming.driver.receive(outputCleared("response-1"))
    noTiming.driver.receive(speechStopped("item-user-1"))
    noTiming.driver.receive(transcript("item-user-1", ""))

    const noTruncation = driver()
    noTruncation.driver.receive(responseCreated("response-1"))
    noTruncation.driver.receive(speechStarted("item-user-1", 1_000))
    noTruncation.driver.receive(responseDone("response-1"))
    noTruncation.driver.receive(speechStopped("item-user-1", 1_240))
    noTruncation.driver.receive(transcript("item-user-1", ""))

    const failed = driver()
    failed.driver.receive(responseCreated("response-1"))
    failed.driver.receive(speechStarted("item-user-1", 1_000))
    failed.driver.receive(responseDone("response-1"))
    failed.driver.receive(outputCleared("response-1"))
    failed.driver.receive(speechStopped("item-user-1", 1_240))
    failed.driver.receive(event("conversation.item.input_audio_transcription.failed", { item_id: "item-user-1" }))

    expect(noTiming.requests()).toHaveLength(0)
    expect(noTruncation.requests()).toHaveLength(0)
    expect(failed.interruptions).toEqual([expect.objectContaining({ recovered: false })])
  })

  it("answers intentional speech instead of recovering it", () => {
    const short = driver()
    short.driver.receive(responseCreated("response-1"))
    short.driver.receive(speechStarted("item-user-1", 1_000))
    short.driver.receive(responseDone("response-1"))
    short.driver.receive(outputCleared("response-1"))
    short.driver.receive(speechStopped("item-user-1", 1_240))
    short.driver.receive(transcript("item-user-1", "stop"))

    const sentence = driver()
    sentence.driver.receive(responseCreated("response-1"))
    sentence.driver.receive(speechStarted("item-user-1", 1_000))
    sentence.driver.receive(responseDone("response-1"))
    sentence.driver.receive(outputCleared("response-1"))
    sentence.driver.receive(speechStopped("item-user-1", 2_200))
    sentence.driver.receive(transcript("item-user-1", "Stop and show the open Todos"))

    expect(short.requests()).toEqual([{ type: "response.create" }])
    expect(sentence.requests()).toEqual([{ type: "response.create" }])
    expect(sentence.interruptions).toEqual([expect.objectContaining({ recovered: false, speechMs: 1_200 })])
  })

  it("answers meaningful speech when transcription wins the cancellation race", () => {
    const talk = driver()
    talk.driver.receive(responseCreated("response-1"))
    talk.driver.receive(speechStarted("item-user-1", 1_000))
    talk.driver.receive(speechStopped("item-user-1", 1_240))
    talk.driver.receive(transcript("item-user-1", "Stop and show the open Todos"))

    expect(talk.requests()).toHaveLength(0)
    talk.driver.receive(responseDone("response-1"))

    expect(talk.requests()).toEqual([{ type: "response.create" }])
  })

  it("recovers a false start while completed response audio is still playing", () => {
    const talk = driver()
    talk.driver.receive(responseCreated("response-1"))
    talk.driver.receive(outputStarted("response-1"))
    talk.driver.receive(event("response.done", { response: { id: "response-1", status: "completed" } }))
    talk.driver.receive(speechStarted("item-user-1", 1_000))
    talk.driver.receive(outputCleared("response-1"))
    talk.driver.receive(speechStopped("item-user-1", 1_240))
    talk.driver.receive(transcript("item-user-1", ""))

    expect(talk.requests()).toEqual([{
      type: "response.create",
      response: { instructions: expect.stringMatching(/continue.+last spoken boundary/i) },
    }])
  })

  it("never recovers while a tool action is already in flight", async () => {
    let settleAction: (value: Response) => void = () => {}
    authFetch.mockReturnValue(new Promise((resolve) => { settleAction = resolve }))
    const talk = driver()
    talk.driver.receive(responseCreated("response-1"))
    talk.driver.receive(event("response.function_call_arguments.done", {
      call_id: "call-1",
      name: "list_todos",
      arguments: "{}",
    }))
    talk.driver.receive(speechStarted("item-user-1", 1_000))
    talk.driver.receive(responseDone("response-1"))
    talk.driver.receive(outputCleared("response-1"))
    talk.driver.receive(speechStopped("item-user-1", 1_240))
    talk.driver.receive(transcript("item-user-1", ""))
    settleAction(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }))
    await vi.waitFor(() => expect(authFetch).toHaveBeenCalled())

    expect(talk.requests()).toHaveLength(0)
    expect(talk.interruptions).toEqual([])
  })

  it("suppresses recovery after a newer response, user item, or stop", () => {
    const newerResponse = driver()
    newerResponse.driver.receive(responseCreated("response-1"))
    newerResponse.driver.receive(speechStarted("item-user-1", 1_000))
    newerResponse.driver.receive(responseDone("response-1"))
    newerResponse.driver.receive(outputCleared("response-1"))
    newerResponse.driver.receive(speechStopped("item-user-1", 1_240))
    newerResponse.driver.receive(responseCreated("response-2"))
    newerResponse.driver.receive(transcript("item-user-1", ""))

    const newerSpeech = driver()
    newerSpeech.driver.receive(responseCreated("response-1"))
    newerSpeech.driver.receive(speechStarted("item-user-1", 1_000))
    newerSpeech.driver.receive(responseDone("response-1"))
    newerSpeech.driver.receive(outputCleared("response-1"))
    newerSpeech.driver.receive(speechStopped("item-user-1", 1_240))
    newerSpeech.driver.receive(speechStarted("item-user-2", 1_300))
    newerSpeech.driver.receive(transcript("item-user-1", ""))

    const stopped = driver()
    stopped.driver.receive(responseCreated("response-1"))
    stopped.driver.receive(speechStarted("item-user-1", 1_000))
    stopped.driver.receive(responseDone("response-1"))
    stopped.driver.receive(outputCleared("response-1"))
    stopped.driver.receive(speechStopped("item-user-1", 1_240))
    stopped.driver.stop()
    stopped.driver.receive(transcript("item-user-1", ""))

    expect(newerResponse.requests()).toHaveLength(0)
    expect(newerSpeech.requests()).toHaveLength(0)
    expect(stopped.requests()).toHaveLength(0)
  })

  /**
   * The routing this turns on: the operator's own voice has to reach the orb
   * as its own state, and it has to do that without touching the response
   * bookkeeping underneath — the orb is a readout, not a participant.
   */
  it("shows the operator speaking without disturbing the response in flight", () => {
    const quiet = driver()
    quiet.driver.receive(speechStarted("item-user-1", 1_000))
    expect(quiet.states.at(-1)).toBe("user_speaking")
    quiet.driver.receive(speechStopped("item-user-1", 1_800))
    expect(quiet.states.at(-1)).toBe("listening")
    // The VAD pair on its own neither asks for a response nor cancels one; the
    // transcript is what asks.
    expect(quiet.requests()).toHaveLength(0)
    expect(quiet.cancels()).toHaveLength(0)

    const live = driver()
    live.driver.receive(responseCreated("response-1"))
    live.driver.receive(speechStarted("item-user-1", 1_000))
    // Over the assistant it is an interruption, not an ordinary turn.
    expect(live.states.at(-1)).toBe("interrupted")
    live.driver.receive(speechStopped("item-user-1", 1_240))
    expect(live.states.at(-1)).toBe("listening")
    live.driver.receive(transcript("item-user-1", "Stop and show the open Todos"))

    // The response it interrupted still owns the turn until it reports done.
    expect(live.cancels()).toHaveLength(0)
    expect(live.requests()).toHaveLength(0)
    live.driver.receive(responseDone("response-1"))
    expect(live.requests()).toEqual([{ type: "response.create" }])
  })

  it("creates one response for an ordinary user turn", () => {
    const talk = driver()
    talk.driver.receive(speechStarted("item-user-1", 1_000))
    talk.driver.receive(speechStopped("item-user-1", 1_800))
    talk.driver.receive(transcript("item-user-1", "What are we looking at?"))
    talk.driver.receive(transcript("item-user-1", "What are we looking at?"))
    expect(talk.requests()).toEqual([{ type: "response.create" }])
  })
})
