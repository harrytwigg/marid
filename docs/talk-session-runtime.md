# Talk session runtime

Talk is a persistent normal chat with a direct browser-to-realtime-provider audio
connection. The gateway never proxies microphone or speaker bytes. It owns the
operator identity, short-lived provider credential, semantic screen memory,
company-control manifest, durable receipts, approvals, proactive policy, and
accounting. Aurora is the only Talk-specific UI.

## Trust boundary

```text
operator gesture
  -> browser Aurora + WebRTC data channel
     -> semantic screen context / bounded browser effects
     -> authenticated gateway control call
        -> canonical company command
        -> authoritative reread
        -> durable receipt + typed UI effect
```

- The browser may run only manifest entries whose target is `browser`:
  navigation, filtering, focus, reference resolution, and the bounded visual
  fallback.
- Gateway writes require a caller resolved as the authenticated operator. An
  employee, session, unidentified tool, or unauthenticated request is refused.
- A provider call id is an operation identity, not authority. Exact replays
  return the stored receipt; changed arguments under the same id conflict.
- Success is spoken only after the canonical store reread matches the requested
  result. Browser cache invalidation and navigation are typed effects from that
  verified receipt.
- The complete executable and explicit-gap inventories live in
  `talk/control/manifest.ts`, `components/talk/context/coverage.ts`, and
  `docs/talk-control-coverage.md`.

## Durable state

The sessions SQLite database stores focused Talk tables rather than one opaque
JSON blob:

| State | Purpose |
| --- | --- |
| `talk_sessions` and child turn/action tables | browser binding, credential generation, live/parked/closed lifecycle, public turn telemetry |
| normal `sessions` and `messages` rows | searchable user/assistant transcripts and compact tool evidence rendered by the ordinary chat UI |
| `talk_tool_receipts` | exact provider-call fingerprint and verified result for restart-safe replay |
| approval evidence/challenge/audit tables | final provider transcript identity, one-time challenge scope, decision outcome, durable audit |
| `talk_topics` and navigation state | at least twelve addressable active/warm/cool topics, commitments, retrieval anchors, and bounded cooling |
| `talk_proactive_receipts` | event dedupe, quiet/spoken disposition, delivery, acknowledgment, and interruption |

`TalkSessionRegistry` remains the lifecycle interface. In production it is
backed by `TalkSessionRepository`; the in-memory store exists only as a test seam.
A missed heartbeat parks a live session and releases its runtime resources. It
does not delete the normal chat or durable topic/control history.

Closing or choosing start over is terminal only for that Talk runtime. The
previous normal chat remains searchable. A new activation creates a new normal
session and Talk id.

## Screen context and visual fallback

`TalkContextBridge` publishes a versioned `TalkScreenContext` built from the
canonical route descriptor, React Query source objects, and conservative DOM
annotations. The context includes the selected semantic object, relations,
filters, visible items, controls, meaningful text, focus, freshness, missing
fields, and retrieval anchor. Updates are semantic-diffed and coalesced, so an
unchanged screen does not consume another provider update.

Normal questions use this structured context. A screenshot is allowed only
when all of these are true:

1. the current context is partial;
2. the page declares the exact missing visual reason with
   `data-talk-visual-gap`;
3. a final operator utterance identifies the question;
4. the live driver has not already captured that reason for the utterance and
   context revision.

The renderer clones the app root, removes the Aurora overlay, hidden content,
password inputs, autocomplete password controls, and `data-talk-secret` nodes,
then rasterizes without a display-capture permission prompt. It caps dimensions
at 1280x1280 and encoded bytes at 180 KB. The provider receives one
`input_image` item. Only bounded public telemetry is posted to the gateway:
reason, request key, context revision, dimensions, bytes, estimated image
tokens, and latency. The image itself is not persisted.

No core route currently declares a visual gap.

## Company control and recovery

`TalkControlRuntime` consumes the single versioned manifest. The browser cannot
register or override a gateway-target mutation. The runtime validates the JSON
schema, operator requirement, provider call identity, and stable fingerprint
before invoking a domain adapter.

Writes propagate the stable idempotency key
`talk:<talkSessionId>:<providerCallId>` into the canonical command. Todo edits,
comments, assignments, delegations, and chat messages reread
their source of truth and return a typed UI effect. Domain writes that can be
retried have their own stable operation identity, so a lost HTTP response or a
gateway restart does not create a second comment, message, dispatch, or run.

The runtime keeps concurrent duplicate calls on one promise. Successful results
are then stored in `talk_tool_receipts`. A later runtime instance replays the
same result. Transient execution or verification failures are not permanently
cached and may retry with the same call id.

## Voice transcript evidence

Final operator speech is persisted as provider transcript items (one row per
provider item/event, ordered per credential generation) so that operator-bound
writes, such as sending into a named session, can cite the exact utterance that
asked for them. Reusing a provider item or event id with different evidence is
refused. There is no voice approval capability: Todo approvals are not decided
over Talk.

## Topic lifecycle

Every authoritative screen observation can create or refresh a topic. The
resolver scores explicit ids, the selected object, human-label similarity,
recency, active work, relations, and deterministic navigation references such
as “the first one.” Below threshold it returns no match; close scores return a
small candidate set for spoken disambiguation rather than a guess.

Cooling removes bulky raw detail first while preserving goal, current verified
state, decisions, unresolved questions, relations, and retrieval anchors.
Returning to a cooled topic rehydrates it from the source adapter. GC is bounded
and never discards an unresolved commitment merely because it is old.

## Proactive cues, interruption, and failure

Proactive policy deduplicates by event key and topic. Routine/non-blocking cues
remain quiet and use an existing UI refresh or highlight. Urgent cues may produce
one concise utterance. Delivered but unacknowledged cues are returned by the
session status endpoint for reconnect catch-up; acknowledgment is idempotent.

Provider voice-activity start sends one response cancellation and fences late
audio, function output, response creation, and UI effects from the interrupted
turn. A stopped attachment applies no late effects. Unexpected provider close
puts Aurora in its visible error state; retry opens a fresh runtime behind an
operator gesture. Navigation and idempotent control retry remain bounded.

## Lifecycle and endpoints

Nothing opens on mount. The operator activates Aurora, which opens a Talk
session and provider connection. Page navigation keeps it attached. Parking or
page hide closes the provider connection and microphone but remembers the
browser-scoped Talk id. Cold reload performs a status GET only; a fresh gesture
resumes and mints a successor credential.

All session writes require operator authentication.

| Method and path | Purpose |
| --- | --- |
| `POST /api/talk/sessions` | create the normal chat/Talk row and mint generation 1 credential |
| `GET /api/talk/sessions/:id` | durable lifecycle, cost, topic memory/telemetry, manifest, and pending proactive cues |
| `POST .../:id/token` | mint a successor credential generation |
| `POST .../:id/park` / `resume` / `heartbeat` | lifecycle and liveness |
| `POST .../:id/transcript` | atomically persist final provider evidence and a normal user message |
| `POST .../:id/turn` | persist one assistant turn, visual receipts, usage delta, and normal assistant message |
| `POST .../:id/context` | persist one bounded semantic observation and refresh topic memory |
| `POST .../:id/control` | execute one manifest gateway operation and return a verified durable receipt |
| `POST .../:id/actions` | append attempted-write audit, including refusals |
| `POST .../:id/handoff` | create a normal child session through the existing dispatch path |
| `DELETE /api/talk/sessions/:id` | close the runtime while retaining normal chat history |
| `POST /api/talk/proactive/:id/ack` | idempotently record completed/interrupted cue delivery |
| `GET /api/talk/config` | safe provider/setup availability probe |

`GET/POST /api/tts` and `POST /api/stt/transcribe` remain text-chat read-aloud
and dictation features. They are not part of a realtime Talk turn.

## Cost accounting

The normal Talk `sessions` row is the accounting anchor. Each completed provider
turn posts a usage delta, never the provider's running session total. The gateway
prices the delta and calls the existing session accounting path, so Talk appears
in normal cost reports without a second spend ledger.

Usage includes input/output text and audio, cached modality counts, and image
tokens. Visual receipts independently preserve estimated image tokens, bytes,
and latency for audit. Unknown or unpinned realtime models return
`pricingKnown: false`; a recorded zero is then explicitly a floor, never a claim
that the turn was free.

## Verification map

- Route completeness and generated route report:
  `packages/web/src/lib/__tests__/app-routes-talk-coverage.test.ts`
- Semantic context, DOM privacy, and bounded image:
  `packages/web/src/components/talk/context/__tests__/`
- Driver routing, approvals, retry, barge-in, and cues:
  `packages/web/src/components/talk/transport/__tests__/`
- Manifest/company inventory and durable runtime:
  `packages/jinn/src/talk/control/__tests__/`
- Voice transcript evidence: `packages/jinn/src/talk/approval/__tests__/`
- Topic lifecycle and GC: `packages/jinn/src/talk/topics/__tests__/`
- Proactive policy and delivery: `packages/jinn/src/talk/proactive/__tests__/`
  and `packages/jinn/src/gateway/__tests__/talk-proactive-*.test.ts`
- Persistent normal chat/reload: `packages/jinn/src/gateway/__tests__/talk-persistence-api.test.ts`
