# Realtime provider seam

This directory holds the speech-to-speech seam: `RealtimeProvider` in `src/shared/types.ts`, one adapter per
vendor, and `index.ts` as the only construction site. `openai.ts` is implementation 1 (GA `gpt-realtime` over
WebSocket).

Google's Gemini Live API is written up here as implementation 2 rather than built. A seam with one
implementation is a guess; the point of this document is to check the guess against a real second protocol
before anyone pays for the port. Every mapping below names a concrete Gemini message or field, so the day the
adapter is written this file is the spec, not a sales pitch.

Citations use the short keys in [Sources](#sources). Anything not backed by a live page is labelled
**UNVERIFIED** with what was actually checked.

## Member by member

| Member | Gemini Live mechanism | Fit |
|---|---|---|
| `name` | `"gemini"` | Clean. |
| `mintEphemeralToken` | `POST /v1beta/auth_tokens` with an `x-goog-api-key` header; the credential is `token.name`, not a raw secret string [eph] | Strained. Two expiries and `uses: 1`, see [divergence 1](#1-credential-lifecycle). |
| `connect` | WebSocket to the `BidiGenerateContent` endpoint, then a `setup` message carrying `model`, `generationConfig.responseModalities: ["AUDIO"]`, `systemInstruction`, `tools`; resolve the promise on `setupComplete` [live] | Clean, and the same shape impl 1 settled on. `openai.ts` awaits `session.updated` for exactly the reason Gemini has `setupComplete`: resolving on socket open lets the caller push audio into the *default* session, where server VAD is on and a push-to-talk `commitAudio` finds nothing to commit. That race cost a live debugging session, so `setupComplete` is a required await, not an optional nicety. |
| `disconnect` | Close the socket, and drop the stored session resumption handle so the next `connect()` is a new session rather than a resume | Clean, but the handle discard is load bearing, see [divergence 2](#2-connection-lifetime-vs-session-lifetime). |
| `sendAudio` | `realtimeInput` with an inline audio blob, 16-bit PCM, **16 kHz mono** [live] | Strained. Impl 1 is 24 kHz in. The interface carries no rate, see [divergence 3](#3-asymmetric-audio-rates). |
| `commitAudio` | `activityEnd`, valid only when `realtimeInputConfig.automaticActivityDetection.disabled: true` [live] | Strained. Gemini pairs `activityEnd` with an `activityStart` that has no counterpart in the interface, so the adapter must synthesize `activityStart` on the first `sendAudio` after each turn boundary and track that flag itself. There is also no `response.create` equivalent: `activityEnd` both closes the turn and requests the response, where impl 1 sends two messages. |
| `interrupt` | No client-to-server cancel message in the verified set. The adapter can only do the local half (drop queued playback) and, under manual activity detection, send `activityStart` to open a new user turn | Strained, worst member. See [divergence 4](#4-interrupt-is-client-initiated-on-one-side-and-server-announced-on-the-other). |
| `sendToolResult` | `toolResponse.functionResponses[]`, each requiring `id`, `name`, and a `response` object [live] | Absorbable with adapter state. The signature passes `callId` and a JSON string; Gemini also wants the function `name` and an object, so the adapter keeps an id to name map populated from `toolCall.functionCalls[]` and `JSON.parse`es `output`. No interface change, but the adapter is not stateless the way `openai.ts` is (impl 1 replies with `call_id` alone). |
| `on` | Same push model, adapter side only | Clean. |
| `usage` | `usageMetadata` on server messages: `promptTokenCount`, `responseTokenCount`, `totalTokenCount`, plus a `*TokensDetails` breakdown by modality [live] | Mostly clean. The modality breakdown is what fills `inputAudioTokens` / `outputAudioTokens` / `inputTextTokens` / `outputTextTokens`. `cachedInputAudioTokens` / `cachedInputTextTokens` have no named field in the verified set (**UNVERIFIED**: searched the Live API guide and the ephemeral token and session pages for a cached-token field and found none), so a first adapter reports `0` for both. Whether `usageMetadata` is a per-message delta or a session-running total is also **UNVERIFIED**, and it decides whether the adapter accumulates (as `addUsage` does in `openai-usage.ts`) or overwrites. Get that wrong and every cost number doubles. |

### `RealtimeEvent` mapping

| Variant | Gemini source | Fit |
|---|---|---|
| `audio` | `serverContent.modelTurn.parts[].inlineData`, 24 kHz PCM [live] | Clean. Same rate as impl 1 on output, unlike input. |
| `transcript` (assistant) | `serverContent.outputTranscription`, opt-in via `outputAudioTranscription` in `setup` [live] | Strained on `final`. Impl 1 gets a distinct `.done` event carrying the whole transcript; Gemini streams fragments, so `final: true` has to be inferred from `serverContent.turnComplete` and the adapter has to buffer the fragments to produce the final text. |
| `transcript` (user) | `serverContent.inputTranscription`, opt-in via `inputAudioTranscription` [live] | Same inference problem. Also note both are off by default, so an adapter that forgets to request them in `setup` silently emits no transcripts at all. |
| `speech_started` | Nothing direct. The verified message set has no server VAD speech-start notification | Strained. Under automatic VAD the earliest signal the client gets is `serverContent.interrupted`, which only fires when the user talks *over* the model, not on the first word of a normal turn. Under manual activity detection the client sent `activityStart` itself and can emit locally. So the duck-playback cue that impl 1 gets for free is either absent or client-derived. **UNVERIFIED**: checked the Live API guide's server message list for a speech-start event and found only `generationComplete`, `turnComplete`, and `interrupted`. |
| `speech_stopped` | Same as above, plus the client's own `activityEnd` under manual activity | Same. |
| `response_cancelled` `reason: "barge_in"` | `serverContent.interrupted` [live] | Clean, and semantically closer than impl 1's inference. `openai.ts` has to keep a `cancelledByClient` flag and read `response.status === "cancelled"` to guess whether a cancel was a barge-in; Gemini says so outright. |
| `response_cancelled` `reason: "client"` | No producer | See [divergence 4](#4-interrupt-is-client-initiated-on-one-side-and-server-announced-on-the-other). |
| `tool_call` | `toolCall.functionCalls[]`, each with `id`, `name`, `args` [live] | Clean, modulo `args` being an object where the variant declares `arguments: string`, so the adapter stringifies. |
| `turn_done` | `serverContent.turnComplete`, with `usage` read off `usageMetadata` [live] | Clean. `serverContent.generationComplete` is the earlier of the two signals (model finished generating) and should not be mapped here, or the caller will re-arm the mic before playback has drained. |
| `error` | Transport errors and non-JSON frames, same as impl 1 | Clean. |
| `closed` | Socket close | Strained. Gemini closes the connection roughly every 10 minutes by design [session], so a naive mapping emits `closed` mid-conversation. See [divergence 2](#2-connection-lifetime-vs-session-lifetime). |
| (none) | `toolCallCancellation` [live] | Not representable. OpenAI has no equivalent, so the variant does not exist. A caller that ran a slow tool would keep computing an answer the model no longer wants, and then `sendToolResult` into a turn that moved on. |

## Where the two genuinely diverge

### 1. Credential lifecycle

OpenAI mints a client secret at `POST /v1/realtime/client_secrets` with `expires_after.seconds` (default 600,
range 10 to 7200) and states: "Expiration refers to the time after which a client secret will no longer be
valid for creating sessions. The session itself may continue after that time once started. A secret can be
used to create multiple sessions until it expires." [openai-realtime] One expiry, many sessions.

Gemini splits it in two: "By default, you'll have 1 minute to start new Live API sessions using the token from
this request (`newSessionExpireTime`), and 30 minutes to send messages over that connection (`expireTime`)."
And `uses` defaults to 1: "The ephemeral token can only be used to start a single session." [eph]

`RealtimeEphemeralToken` has exactly one `expiresAt`. Neither Gemini value can stand in for it honestly: the
1-minute `newSessionExpireTime` is what a browser must beat to connect at all, the 30-minute `expireTime` is
how long the resulting connection can talk. Report the first and a caller that caches the token thinks it
expired while its live session is fine; report the second and a caller retries a connect that will be refused.
**Needs a change**, and the single-use rule needs to be visible too, or the gateway will hand one token to two
tabs. Also worth noting: "At this time, ephemeral tokens are only compatible with Live API" [eph], so on the
Gemini side `mintEphemeralToken` is the only supported browser path, not an optimization.

### 2. Connection lifetime vs session lifetime

OpenAI: "The maximum duration of a Realtime session is 60 minutes." [openai-realtime] No connection-level
reset, no resumption concept. `openai.ts` therefore treats one socket as one session and emits `closed` when
it drops, which is correct there.

Gemini separates the two. "Without compression, audio-only sessions are limited to 15 minutes, and audio-video
sessions are limited to 2 minutes... you can use context window compression to extend sessions to an unlimited
amount of time." And: "The lifetime of a connection is limited as well, to around 10 minutes. When the
connection terminates, the session terminates as well. In this case, you can configure a single session to
stay active over multiple connections using session resumption. You'll also receive a `GoAway` message before
the connection ends." [session] Resumption means setting `sessionResumption` in `setup`, storing the
`SessionResumptionUpdate` handles the server pushes, and passing the last one as
`SessionResumptionConfig.handle` on reconnect; handles stay valid for 2 hours after the session ends
[session]. The 15-minute cap is lifted with `contextWindowCompression` (sliding window plus a trigger token
count).

The interface **absorbs this**, but only if the adapter hides it: reconnect internally on `GoAway`, replay the
handle, and do not emit `closed` for a planned cycle. What breaks is documentation, not types. The
`RealtimeProvider` doc comment says "One instance owns one connection," and for Gemini it is one instance owns
one *session* across many connections. That sentence should be softened before the adapter lands, because it
is the sentence that would tempt an implementer to emit `closed` every 10 minutes.

### 3. Asymmetric audio rates

OpenAI runs 24 kHz both directions and `openai.ts` hardcodes `format: { type: "audio/pcm", rate: 24000 }` on
input and output. Gemini takes 16 kHz mono in and emits 24 kHz out [live].

`sendAudio(pcm: Buffer)` carries no rate, and the only hint anywhere is the `audio` event comment, "PCM16 mono
at the provider's session rate," which covers output and says nothing about what the caller must capture at.
Today that is harmless because the one implementation is symmetric. With Gemini it becomes a silent
correctness bug: feed 24 kHz PCM into a 16 kHz input and the model hears fast, high-pitched speech and mostly
transcribes noise. Nothing throws. **Needs a change**: the provider has to publish its input and output
sample rates so the capture path can resample.

### 4. Interrupt is client-initiated on one side and server-announced on the other

OpenAI gives the client `response.cancel`, which is exactly `interrupt()`, and the resulting `response.done`
with `status: "cancelled"` is what `openai.ts` attributes to `"client"` or `"barge_in"` via its own flag.

Gemini's documented interruption is the server's: VAD detects the user over the model, the server sends
`serverContent.interrupted`, and the client discards queued playback [live]. That is the `"barge_in"` half,
and it maps better than impl 1's guess. The `"client"` half has no verified producer. **UNVERIFIED**: the
client-to-server messages in the checked material are `setup`, `realtimeInput`, `toolResponse`, `activityStart`,
and `activityEnd`; none is documented as cancelling an in-flight model turn. Confirm before building.

The interface absorbs the degraded version (drop local playback, emit
`response_cancelled { reason: "client" }` optimistically) but that is a lie if the server keeps generating and
billing. Worth resolving at build time rather than papering over.

### 5. Silence billing

OpenAI: "VAD will effectively filter out empty input audio, so empty audio doesn't count as input tokens
unless the client manually adds it as conversation input." [openai-costs] That is why a hot mic under
`turnDetection: "server_vad"` is affordable on impl 1.

Gemini publishes no equivalent statement. **UNVERIFIED**: searched the Gemini pricing page and the Live API
guides for "silen", "idle", and "billed", and found only the `silenceDurationMs` VAD knob under
`realtimeInputConfig.automaticActivityDetection`. Do not assume either way. This is not an interface problem,
it is a defaults problem: the existing bias toward `turnDetection: "none"` for metered billing is the right
default to keep for a Gemini adapter until someone measures it.

## Verdict

The seam holds. Nine of the ten members map onto a named Gemini mechanism, `connect` acknowledges the same way
on both sides, and `response_cancelled` sourced from an explicit `interrupted` signal comes out cleaner than
impl 1's inference. The event vocabulary survives because it was defined in terms of what a caller observes
rather than what OpenAI emits.

Three honest strains, in the order they would bite:

1. `RealtimeEphemeralToken` cannot express Gemini's two expiries or its single-use rule. This is the one
   member that **must** change in `src/shared/types.ts`: add the second deadline (the session-start window,
   distinct from the message window) and a use count, both optional so `openai.ts` is untouched.
2. Sample rate is unpublished. Add readonly input and output rates to `RealtimeProvider` (or return them from
   `connect`), because the failure mode is silent garbage rather than an exception.
3. `interrupt()` may be half-implementable, and `toolCallCancellation` has nowhere to go. The first is a
   research item to close before writing code; the second is a new `RealtimeEvent` variant that only one
   provider will ever emit, which is acceptable (callers already switch on `type`) but should be added
   deliberately rather than discovered.

Everything else is adapter-local work: an id to name map for tool responses, fragment buffering for
transcripts, synthesized `activityStart`, and transparent reconnection behind `GoAway`. That is the correct
distribution. If the divergences had landed in `connect`, `sendAudio`, and `on` instead, the seam would be in
the wrong place.

## Sources

All accessed 2026-08-06.

- `[live]` Gemini Live API guide: https://ai.google.dev/gemini-api/docs/live-api
- `[eph]` Gemini ephemeral tokens: https://ai.google.dev/gemini-api/docs/ephemeral-tokens
- `[session]` Gemini session management: https://ai.google.dev/gemini-api/docs/live-session
- `[openai-realtime]` OpenAI realtime conversations: https://developers.openai.com/api/docs/guides/realtime-conversations
- `[openai-costs]` OpenAI realtime costs: https://developers.openai.com/api/docs/guides/realtime-costs
