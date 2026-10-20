/**
 * Content-free provider traces for the seven interruption cases.
 *
 * These fixtures start at the browser's real seam: events emitted by provider
 * VAD. They deliberately do not pretend the browser can run provider VAD over
 * checked-in PCM. Text is either empty or an explicitly synthetic marker.
 */

export type VadFixtureDisposition = "playing" | "recovered" | "interrupted"

export interface ScriptedProviderEvent {
  label: string
  atMs: number
  frame: Readonly<Record<string, unknown>>
}

export interface VadFixtureExpected {
  disposition: VadFixtureDisposition
  clientCancels: 0
  normalResponses: number
  continuationResponses: number
  finalizedInterruptions: number
  normalResponseAt?: string
  telemetry: ReadonlyArray<{
    kind: "speech_interruption"
    vadType: "server_vad"
    cancelledBy: "provider"
    recovered: boolean
    speechMs: number | null
  }>
}

export interface VadFixture {
  id: "silence" | "light-taps" | "cough-breath" | "cabin-road"
    | "accidental-syllable" | "natural-pause" | "deliberate-interruption"
  source: "scripted-provider-events"
  events: readonly ScriptedProviderEvent[]
  expected: VadFixtureExpected
}

const RESPONSE_ID = "response-synthetic-1"
const USER_ITEM_ID = "item-synthetic-1"

function event(
  label: string,
  atMs: number,
  type: string,
  fields: Record<string, unknown> = {},
): ScriptedProviderEvent {
  return { label, atMs, frame: { type, ...fields } }
}

function playback(): ScriptedProviderEvent[] {
  return [
    event("assistant-started", 0, "response.created", { response: { id: RESPONSE_ID } }),
    event("playback-started", 10, "output_audio_buffer.started", { response_id: RESPONSE_ID }),
  ]
}

function speechStarted(atMs = 100): ScriptedProviderEvent {
  return event("speech-started", atMs, "input_audio_buffer.speech_started", {
    item_id: USER_ITEM_ID,
    audio_start_ms: 1_000,
  })
}

function speechStopped(atMs: number, audioEndMs: number): ScriptedProviderEvent {
  return event("speech-stopped", atMs, "input_audio_buffer.speech_stopped", {
    item_id: USER_ITEM_ID,
    audio_end_ms: audioEndMs,
  })
}

function transcript(label: string, atMs: number, text: string): ScriptedProviderEvent {
  return event(label, atMs, "conversation.item.input_audio_transcription.completed", {
    item_id: USER_ITEM_ID,
    event_id: "event-synthetic-1",
    transcript: text,
  })
}

function providerCancelled(atMs: number): ScriptedProviderEvent {
  return event("provider-cancelled", atMs, "response.done", {
    response: {
      id: RESPONSE_ID,
      status: "cancelled",
      status_details: { reason: "turn_detected" },
    },
  })
}

function playbackCleared(atMs: number): ScriptedProviderEvent {
  return event("playback-cleared", atMs, "output_audio_buffer.cleared", { response_id: RESPONSE_ID })
}

function assistantCompleted(atMs: number): ScriptedProviderEvent {
  return event("assistant-completed", atMs, "response.done", {
    response: { id: RESPONSE_ID, status: "completed" },
  })
}

const noInterruption = {
  disposition: "playing",
  clientCancels: 0,
  normalResponses: 0,
  continuationResponses: 0,
  finalizedInterruptions: 0,
  telemetry: [],
} as const

export const VAD_FIXTURES: readonly VadFixture[] = [
  {
    id: "silence",
    source: "scripted-provider-events",
    events: playback(),
    expected: noInterruption,
  },
  {
    id: "light-taps",
    source: "scripted-provider-events",
    // Noise reduction and provider VAD emitted no speech edge for the taps.
    events: playback(),
    expected: noInterruption,
  },
  {
    id: "cough-breath",
    source: "scripted-provider-events",
    events: [
      ...playback(),
      speechStarted(),
      speechStopped(310, 1_210),
      transcript("empty-transcript", 330, ""),
      assistantCompleted(500),
      event("playback-stopped", 510, "output_audio_buffer.stopped", { response_id: RESPONSE_ID }),
    ],
    expected: noInterruption,
  },
  {
    id: "cabin-road",
    source: "scripted-provider-events",
    // A steady far-field bed produces no provider speech edge.
    events: playback(),
    expected: noInterruption,
  },
  {
    id: "accidental-syllable",
    source: "scripted-provider-events",
    events: [
      ...playback(),
      speechStarted(),
      providerCancelled(150),
      playbackCleared(170),
      speechStopped(360, 1_260),
      transcript("empty-transcript", 390, ""),
    ],
    expected: {
      disposition: "recovered",
      clientCancels: 0,
      normalResponses: 0,
      continuationResponses: 1,
      finalizedInterruptions: 0,
      telemetry: [{
        kind: "speech_interruption",
        vadType: "server_vad",
        cancelledBy: "provider",
        recovered: true,
        speechMs: 260,
      }],
    },
  },
  {
    id: "natural-pause",
    source: "scripted-provider-events",
    events: [
      ...playback(),
      speechStarted(),
      speechStopped(900, 1_800),
      transcript("synthetic-phrase", 940, "synthetic phrase with a natural pause"),
      assistantCompleted(1_000),
      event("playback-stopped", 1_010, "output_audio_buffer.stopped", { response_id: RESPONSE_ID }),
    ],
    expected: {
      disposition: "playing",
      clientCancels: 0,
      normalResponses: 1,
      continuationResponses: 0,
      finalizedInterruptions: 0,
      normalResponseAt: "assistant-completed",
      telemetry: [],
    },
  },
  {
    id: "deliberate-interruption",
    source: "scripted-provider-events",
    events: [
      ...playback(),
      speechStarted(),
      providerCancelled(140),
      playbackCleared(160),
      speechStopped(1_000, 1_900),
      transcript("meaningful-transcript", 1_040, "synthetic deliberate multi word interruption"),
    ],
    expected: {
      disposition: "interrupted",
      clientCancels: 0,
      normalResponses: 1,
      continuationResponses: 0,
      finalizedInterruptions: 1,
      normalResponseAt: "meaningful-transcript",
      telemetry: [{
        kind: "speech_interruption",
        vadType: "server_vad",
        cancelledBy: "provider",
        recovered: false,
        speechMs: 900,
      }],
    },
  },
]
