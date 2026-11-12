# Contracts: HTTP and MCP

QA diffs every endpoint below against the live gateway (status codes and response keys).
No new routes: the operator path extends `PUT|PATCH /api/sessions/:id`, the session path
extends `POST /api/compactions`.

## 1. `PUT|PATCH /api/sessions/:id` — operator selector (new field)

Operator only (unchanged).

| Field | Type | Meaning |
|---|---|---|
| `profile` | `string \| null` (optional) | Declared local Claude account name, or `null` for own login. Only with engine `claude` (given or current). |

`engine: "claude:<name>"` stays refused (400, existing wording); `profile` is the way.

A change of engine and/or profile goes through `switchSessionTarget` (park, pointer), clears
any pending session switch, writes `lastSwitch {by: "operator", carryOver: "transcript-pointer"}`
and a notice. Same engine and profile: today's model/effort path.

| Case | Status | Body |
|---|---|---|
| applied | 200 | serialised session; `claudeProfile` reflects the new profile (`null` for own login) |
| `profile` with a non-claude engine | 400 | `{error: "profile applies only to the claude engine"}` |
| unknown profile | 400 | `{error: "unknown Claude profile \"x\" — declared profiles: a, b"}` |
| remote employee's session | 400 | `{error: "…runs on a remote host and uses that host's Claude login…"}` |
| turn running/waiting/queued | 400 | `{error: "Cannot switch engine or profile while a turn is running, waiting, or queued"}` |
| scoped session, non-claude engine | 400 | existing `scopedSwitchRefusal` text |

## 2. `POST /api/compactions` — session switch (new optional fields)

Session callers only, self only (unchanged). A body with none of `engine`, `profile`, `model`
behaves exactly as today. With any of them:

```json
{ "goal": "…", "done": "…", "next": "…", "context": "…", "waitingOn": "…",
  "engine": "claude", "profile": "work", "model": "sonnet" }
```

`profile: ""` = own login. A `sessionId` in the body is ignored.

Order: stopped/terminal → body → re-check → **target** → handoff → claim → queued → pending
switch → `/compact` turn (when the engine compacts natively) → stopgap suppression → resume.

| Case | Status | Body |
|---|---|---|
| scheduled | 202 | `{status: "scheduled", sessionId, engine, resume, switch: {from, to, conversation: "same" \| "new", compaction: "queued" \| "skipped"}}` |
| not a session caller | 403 | `{error: UNIDENTIFIED_TOOL_CALL_ERROR}` (unchanged) |
| unknown session | 403 | `{error: UNIDENTIFIED_TOOL_CALL_ERROR}`: the identity check runs first, as on main, so an unknown session reads as an unidentified caller (not 404) |
| stopped | 409 | `{code: "stopped", error}` (unchanged) |
| terminal session | 409 | unchanged |
| unknown/uninstalled engine (incl. `"?"`), unknown model, unknown profile, profile on a non-claude engine | 400 | `{code: "invalid-target", error, targets}` |
| equal to own target | 400 | `{code: "same-target", error: "…already runs on … — call compact_session without a target to compact in place", targets}` |
| scoped → non-claude engine; remote → local profile | 403 | `{code: "not-allowed", error, targets}` |
| target out of allowance | 409 | `{code: "target-exhausted", error: "… resets at <ISO>", until, targets}` |
| invalid handoff | 400 | unchanged |
| cooldown | 429 | `{error, retryAt}` (unchanged) |
| messages queued | 409 | unchanged wording |
| `/compact` turn not queued | 502 / 409 stopped | unchanged; claim released, `pendingSwitch` removed |
| resume not recorded | 500 | `{error: "the compaction is queued and will run, but the resume could not be recorded, so no switch was scheduled (…). End your turn with the handoff written out in your reply."}`; claim kept, `pendingSwitch` removed |

Every target refusal's `error` ends with the list rendered as text, because the MCP wrapper
passes `error` through and drops other keys. Bound: the whole `error` ≤ 1,800 characters; an
engine whose models do not fit ends "+N more (call with engine "<name>", model "?" for its
list)"; a call with a named engine and `model: "?"` renders only that engine, same bound.
Example:

```text
unknown engine "?" — call again with one of these. Now: claude · own login · opus.
claude: profiles "" (own login), work (exhausted until 2026-11-12T15:00Z); models opus, sonnet, haiku.
opencode: models provider/a, provider/b, … +40 more (call with engine "opencode", model "?" for its list).
```

The structured `targets` (for HTTP callers and tests):

```json
{
  "current": { "engine": "claude", "profile": null, "model": "opus" },
  "engines": [
    { "name": "claude", "defaultModel": "opus", "health": { "state": "ok" },
      "models": [ { "id": "opus", "label": "Opus", "contextWindow": 200000 } ],
      "profiles": [
        { "name": "", "label": "own login", "health": { "state": "ok" } },
        { "name": "work", "label": "work", "health": { "state": "exhausted", "until": "2026-11-12T15:00:00.000Z" } } ] },
    { "name": "opencode", "defaultModel": "provider/model", "health": { "state": "ok" }, "models": [] }
  ]
}
```

- `engines`: installed where the session runs; scoped session → `claude` only; remote
  employee's session → engines its host runs.
- `profiles`: Claude only; own login first (`name: ""`); declared local accounts; omitted for a
  remote employee's session.

## 3. MCP `compact_session`

```text
compact_session {goal, done, next, context?, waitingOn?, engine?, profile?, model?}
  description: "Compact your own session's context (never from a Task sub-agent); resume from
  this handoff, optionally on another engine/profile/model. End your turn after."
```

The handler forwards the three fields when present. On 202 with `switch`, the hint is the
existing "END YOUR TURN NOW…".

## 4. Resume message at apply

```
[Session switch resume] You asked to move this session (compact_session). It now runs on
<Engine · profile · model>. <carry-over line>
## Goal / ## Done / ## Next / ## Context / ## Waiting on   (verbatim handoff)
```

Carry-over line:
- same conversation: "Your context was compacted in place."
- summary: "This is a new conversation. The summary of the previous one follows, then your
  handoff." + summary + "Earlier detail: read_session {sessionId: "<id>"}[ or <path>]."
- manual handover: "This is a new conversation and the previous one could not be summarised
  (<reason>). Your earlier history is not repeated here: read it with read_session
  {sessionId: "<id>", last: 100}[ and <path>] before resuming."
- not applied: "The switch to <target> did not happen (<reason>); you are still on <current>.
  Your context was <compacted | not compacted>."
