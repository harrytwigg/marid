# Realtime voice providers: billing, cost, and what it decides

Everything here was checked against live vendor pages on **2026-08-06**. Prices and
limits move; re-check before making a decision that depends on a number.

The question this document exists to answer: **can a voice session ride on a
subscription somebody already pays for, or is it metered API usage?** The answer
decides whether the voice surface can hold an open microphone or has to be
push-to-talk, so it gates the design rather than following it.

---

## 1. Subscription or metered?

**Metered API usage. Neither provider documents a subscription-attached path,
both document the separation explicitly, and building one on a consumer
credential would breach OpenAI's terms.** The stronger claim, that no such path
exists anywhere whether documented or not, was not established; it stays
UNVERIFIED in section 5, and the terms position below is what makes the
distinction moot in practice.

### OpenAI

A ChatGPT Plus/Pro or Codex subscription does not grant Realtime API access.
OpenAI separates the two credential systems explicitly in its own Codex
documentation:

> "Access tokens are intended for trusted scripts, schedulers, and private CI
> runners. For general OpenAI API calls, continue to use Platform API keys."

> "OpenAI bills API key usage through your OpenAI Platform account at standard
> API rates."

Source: <https://developers.openai.com/codex/auth> (accessed 2026-08-06).

Realtime models are listed only on the platform pricing page, priced per token,
with no subscription tier alongside them. Source:
<https://developers.openai.com/api/docs/pricing.md> (accessed 2026-08-06).

### Google

Same shape, stated even more directly:

> "Google AI plan benefits for developer usage apply only within the Google AI
> Studio web interface. Direct use of the Gemini API (such as using API keys or
> external applications) is billed and managed separately."

Source: <https://ai.google.dev/gemini-api/docs/google-ai-plans> (accessed
2026-08-06), under "Limitations and compatibility". The same section adds that
Google AI plans "are separate from Gemini API usage tiers, which cover
development and production API usage".

### The terms position on a subscription-attached path

Not merely absent: prohibited. Driving voice traffic through a consumer ChatGPT
credential runs into two clauses of the OpenAI Terms of Use, but they do not
bite equally, and conflating them overstates the case.

| Clause | Wording | Where | When it bites |
|---|---|---|---|
| Automated extraction | "Automatically or programmatically extracting data or Output (defined below)." | Using our Services, "What you cannot do" | Always. Any programmatic drive of a consumer credential is this, including one person automating their own account locally. |
| Credential sharing | "You may not share your account credentials or make your account available to anyone else and are responsible for all activities that occur under your account." | Registration and access, "Registration." | Only once the credential leaves its account holder. |

Source: <https://openai.com/policies/terms-of-use/> (accessed 2026-08-06).

The second clause is the one that is easy to over-read. A single user running
local automation against their own subscription shares nothing and makes their
account available to nobody, so credential sharing is not entailed. It becomes
the operative clause in the shape this gateway would actually take: a server
holding one subscription credential and minting voice sessions for other
people. The extraction clause alone is enough to rule the path out either way,
which is why the conclusion does not depend on the sharing clause applying.

Two caveats worth carrying, because both bit during verification:

- **The URL is geo-routed.** From an EEA/UK/Swiss address it serves "Europe
  Terms of Use, Updated: January 16, 2026". The global version lives at
  <https://openai.com/policies/row-terms-of-use/> and reads "Effective: January
  1, 2026". The credential clause is word-for-word identical in both. The
  extraction clause differs only in verb form ("extracting" in the Europe
  version, "extract" in the global one) because the lead-in sentence differs.
  Cite the version you actually read.
- **The page is 403 to non-browser clients.** Both `curl` and a fetch tool were
  refused; the text above was read through a real browser.

Consumer ChatGPT and the API are also governed by different contracts, so a
consumer entitlement does not reach an API endpoint even before the clauses
above apply.

### What is unverified

- **UNVERIFIED: whether any undocumented realtime endpoint accepts ChatGPT
  sign-in credentials.** This is absence of evidence, not a denial. What was
  checked: the Codex auth doc, the platform pricing page, the Realtime guides,
  and the ChatGPT usage-limit documentation. None describes a voice or realtime
  endpoint reachable with subscription credentials. No attempt was made to probe
  for one, because the terms clauses above make it prohibited whether or not it
  exists.

### What this decides

Every second of an open microphone is billable, so **the voice surface defaults
to push-to-talk, not a hot mic.** The one qualifier is in section 3.

---

## 2. Rates the cost table is built from

**OpenAI audio token rate**, verbatim from
<https://developers.openai.com/api/docs/guides/realtime-costs> (accessed
2026-08-06):

> "Audio tokens in user messages are 1 token per 100 ms of audio, while audio
> tokens in assistant messages are 1 token per 50ms of audio."

Which converts to:

```
input   1 token / 100 ms  = 10 tokens/s  = 36,000 tokens/hour
output  1 token /  50 ms  = 20 tokens/s  = 72,000 tokens/hour
```

**Confirmed by measurement**, not just by reading. `scripts/realtime-echo.mjs`
sent 5.85 s of speech and received 7.30 s back, and the API reported 58 input
audio tokens and 146 output audio tokens:

```
5.85 s x 10 tokens/s = 58.5  ->  reported 58
7.30 s x 20 tokens/s = 146.0 ->  reported 146
```

**Per-1M audio prices**, from
<https://developers.openai.com/api/docs/pricing.md> (accessed 2026-08-06), under
"Realtime and audio generation models", "Prices per 1M tokens unless noted":

| Model | Audio in | Cached audio in | Audio out |
|---|---|---|---|
| `gpt-realtime-2.1` | $32.00 | $0.40 | $64.00 |
| `gpt-realtime-2.1-mini` | $10.00 | $0.30 | $20.00 |

Text tokens on the same models (tool arguments and results are text): `2.1` is
$4.00 in / $0.40 cached / $24.00 out; `2.1-mini` is $0.60 / $0.06 / $2.40.

**Gemini Live**, from <https://ai.google.dev/gemini-api/docs/pricing> (accessed
2026-08-06). The table's own column header is "Paid Tier, per 1M tokens in USD",
with a per-minute equivalent printed inside each cell, so this is token pricing
with a duration convenience figure rather than duration pricing:

| Model | Audio in | Audio out |
|---|---|---|
| `gemini-3.1-flash-live-preview` | $3.00 per 1M, or $0.005/min | $12.00 per 1M, or $0.018/min |

Text tokens on the same model, from the same table (tool arguments and results
are text): $0.75 per 1M in, $4.50 per 1M out. These are priced per token only.
Google prints no per-minute equivalent for text, because text does not have a
duration.

---

## 3. Cost table: dollars per hour

Three states, defined so the numbers mean the same thing across providers:

- **Idle with hot mic**: connection open, microphone streaming, nobody
  speaking.
- **Listening**: one continuous hour of user speech, no assistant output. The
  worst realistic input-only case.
- **Active with tools**: a real conversation. Stated assumption: an hour split
  30 min of user speech and 30 min of assistant speech, plus 20 tool round trips
  averaging 300 input and 100 output text tokens each.

| State | `gpt-realtime-2.1` | `gpt-realtime-2.1-mini` | `gemini-3.1-flash-live-preview` |
|---|---|---|---|
| Idle with hot mic | **$0.00/hr** (conditional, see below) | **$0.00/hr** (conditional) | **$0.30/hr** (assumed worst case, see below) |
| Listening | **$1.15/hr** | **$0.36/hr** | **$0.30/hr** |
| Active with tools | **$2.95/hr** | **$0.91/hr** | **$0.70/hr** |

### The arithmetic

**Listening**, one hour of user audio only:

```
gpt-realtime-2.1       36,000 tok x $32.00/1M = $1.152/hr
gpt-realtime-2.1-mini  36,000 tok x $10.00/1M = $0.360/hr
gemini-3.1-flash-live  60 min    x $0.005/min = $0.300/hr
```

**Active with tools**, 30 min in and 30 min out plus the tool text:

```
gpt-realtime-2.1
  audio in    18,000 tok x $32.00/1M = $0.576
  audio out   36,000 tok x $64.00/1M = $2.304
  tool in      6,000 tok x  $4.00/1M = $0.024
  tool out     2,000 tok x $24.00/1M = $0.048
                                       -------
                                       $2.952/hr  -> $2.95

gpt-realtime-2.1-mini
  audio in    18,000 tok x $10.00/1M = $0.180
  audio out   36,000 tok x $20.00/1M = $0.720
  tool in      6,000 tok x  $0.60/1M = $0.0036
  tool out     2,000 tok x  $2.40/1M = $0.0048
                                       -------
                                       $0.908/hr  -> $0.91

gemini-3.1-flash-live
  audio in    30 min x $0.005/min = $0.150
  audio out   30 min x $0.018/min = $0.540
  tool in      6,000 tok x $0.75/1M = $0.0045
  tool out     2,000 tok x $4.50/1M = $0.0090
                                      -------
                                      $0.7035/hr -> $0.70
```

The Gemini per-minute figures cover audio only. Tool text is priced separately
per token on the same page, so it is added the same way it is for OpenAI rather
than assumed to be inside the per-minute rate.

Tool text is under 3% of the total on all three models and is dwarfed by the
exclusion in the next section, so the tool assumption is not worth tuning.

### Idle with hot mic is conditionally free, not free

OpenAI, verbatim from the realtime cost guide (accessed 2026-08-06):

> "VAD will effectively filter out empty input audio, so empty audio doesn't
> count as input tokens unless the client manually adds it as conversation
> input."

The trailing condition is the whole caveat. Silence is free **only** while
server-side VAD is on and the client is not committing silent buffers itself. A
push-to-talk client that disables VAD and commits whatever it captured pays for
that silence. This is the one place the hot-mic default could be revisited, and
it is conditional enough that push-to-talk remains the right default.

Gemini publishes no equivalent statement, so its idle figure is an assumption
rather than a reading. The table carries the worst case: silence streamed into
an open session is billed as ordinary audio input, which is the same rate as
listening.

```
gemini-3.1-flash-live  60 min x $0.005/min = $0.300/hr  (assumed worst case)
                                             $0.000/hr  (floor, if silence is
                                                         filtered as on OpenAI)
```

Budget against $0.30/hr and treat anything less as recovered. **UNVERIFIED:
whether Gemini bills silence or an idle open session.** What was checked: the
pricing page and the Live API guides, searched for "silen", "idle", "billed",
and "billing". The only match is the `silence_duration_ms` VAD tuning knob.
Google publishes no statement either way. Do not assume the per-minute figure
implies billing by wall-clock duration, and do not assume it does not.

### What these floors exclude

**These are audio-stream floors. A real session costs more.** The largest
excluded term is context re-submission, verbatim from the OpenAI cost guide
(accessed 2026-08-06):

> "The entire conversation is sent to the model for each Response. The output
> from a turn will be added as Items to the server Conversation and become the
> input to subsequent turns, thus turns later in the session will be more
> expensive."

So input tokens grow with conversation length, and a long session costs
materially more per minute at its end than at its start. Prompt caching offsets
this but does not remove it:

> "Realtime API supports prompt caching, which is applied automatically and can
> dramatically reduce the costs of input tokens during multi-turn sessions.
> Caching applies when the input tokens of a Response match tokens from a
> previous Response, though this is best-effort and not guaranteed."

The cache is fragile in a way that matters for design: "Removing or changing
content in the conversation will 'bust' the cache up to the point of the
change", and truncation on every turn drives the cache rate to nearly zero. A
voice surface that rewrites its own history per turn will pay full input price
forever.

The echo run showed caching engaging immediately: 64 of 119 input text tokens
came back cached on the very first turn.

Also excluded: the system prompt and tool schemas resubmitted per turn, and any
audio the client commits outside the states above. Not a cost: "There is no cost
currently for network bandwidth or connections."

---

## 4. Transport and credential facts the adapter depends on

| | OpenAI Realtime | Gemini Live |
|---|---|---|
| Ephemeral token endpoint | `POST https://api.openai.com/v1/realtime/client_secrets` | `POST https://generativelanguage.googleapis.com/v1beta/auth_tokens` |
| Token TTL | `expires_after.seconds`, default 600, range 10 to 7200 | `expireTime` default 30 min; `newSessionExpireTime` default 1 min |
| Token reuse | Multi-use within its TTL | `uses` defaults to 1 |
| Max session | 60 minutes | 15 min audio-only, 2 min audio-video, unlimited with context compression |
| Connection lifetime | Session lifetime | About 10 minutes, then reconnect with a resumption token |

Sources, all accessed 2026-08-06:
<https://developers.openai.com/api/reference/resources/realtime/subresources/client_secrets/methods/create>,
<https://developers.openai.com/api/docs/guides/realtime-conversations>,
<https://ai.google.dev/gemini-api/docs/ephemeral-tokens>,
<https://ai.google.dev/gemini-api/docs/live-session>.

One asymmetry worth flagging early, because it is easy to get backwards. OpenAI:
"A secret can be used to create multiple sessions until it expires." Gemini:
"The ephemeral token can only be used to start a single session." A gateway that
mints one token per client works on both; a gateway that mints one token per
user and caches it works only on OpenAI.

The interface these facts feed is `RealtimeProvider` in
`packages/hundredfold/src/shared/types.ts`. `packages/hundredfold/src/talk/realtime/README.md`
works the Gemini side through that interface member by member.

---

## 5. Unverified register

| Claim | Status | What was checked |
|---|---|---|
| No realtime endpoint accepts ChatGPT subscription credentials | UNVERIFIED (absence of evidence) | Codex auth doc, platform pricing, Realtime guides, ChatGPT usage limits |
| Gemini bills silence / idle open sessions | UNVERIFIED | Gemini pricing page and Live API guides searched for silence, idle, billed, billing |
| Gemini per-minute figures are billed by wall-clock duration | UNVERIFIED | Pricing table states "per 1M tokens" as the unit with per-minute as an equivalent; no billing-basis statement found |
