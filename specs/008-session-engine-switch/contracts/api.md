# Contracts: HTTP and MCP

QA diffs every endpoint below against the live gateway (status codes and response keys).

## 1. `PUT|PATCH /api/sessions/:id` — operator selector (existing route, new field)

Operator only (unchanged: `control-plane-routes.ts`).

Request body, new field:

| Field | Type | Meaning |
|---|---|---|
| `profile` | `string \| null` (optional) | Declared local Claude account name, or `null` for own login. Only with `engine` `"claude"` (given or current). |

`engine: "claude:<name>"` is still refused (400, unchanged wording); `profile` is the way.

Behaviour: a change of engine and/or profile goes through `switchSessionTarget` with
`leftConversation: "park"`, `sync: "pointer"`, writes `lastSwitch` `{by: "operator", carryOver: "transcript-pointer"}`
and a switch notice. Same engine and same profile: today's model/effort path.

| Case | Status | Body |
|---|---|---|
| applied | 200 | serialised session (as today), `claudeProfile` reflects the new profile |
| `profile` with a non-claude engine | 400 | `{error: "profile applies only to the claude engine"}` |
| unknown profile | 400 | `{error: "unknown Claude profile \"x\" — declared profiles: a, b"}` |
| remote employee's session | 400 | `{error: "…runs on a remote host and uses that host's Claude login…"}` |
| turn running/waiting/queued | 400 | existing `"Cannot switch engine while a turn is running, waiting, or queued"` (wording extended to "engine or profile") |
| scoped session, non-claude engine | 400 | existing `scopedSwitchRefusal` text |

## 2. `GET /api/session-targets` — list tool

Session callers only (`identity.kind === "session"`), answers for the caller. Others: 403
`UNIDENTIFIED_TOOL_CALL_ERROR`. Department-scope rule: pass.

200:

```json
{
  "current": { "engine": "claude", "profile": null, "model": "opus", "effortLevel": "high" },
  "engines": [
    {
      "name": "claude",
      "defaultModel": "opus",
      "health": { "state": "ok" },
      "models": [ { "id": "opus", "label": "Opus", "effortLevels": ["low","medium","high"], "contextWindow": 200000 } ],
      "profiles": [
        { "name": null, "label": "own login", "health": { "state": "ok" } },
        { "name": "work", "label": "work", "health": { "state": "exhausted", "until": "2026-11-12T15:00:00.000Z" } }
      ]
    },
    { "name": "opencode", "defaultModel": "provider/model", "health": { "state": "ok" }, "models": [] }
  ],
  "hint": "Pass engine/profile/model from this list to switch_session."
}
```

- `engines`: only engines installed where the session runs; a scoped session gets only
  `claude`; a remote employee's session gets only engines its host runs.
- `profiles`: Claude only; own login first; declared **local** accounts. Omitted entirely for
  a remote employee's session.
- `health.state`: `ok | exhausted | degraded`; `until` when known.

## 3. `POST /api/session-switches` — switch tool

Session callers only, self only. Department-scope rule: pass.

Request:

```json
{
  "goal": "…", "done": "…", "next": "…", "context": "…", "waitingOn": "…",
  "engine": "claude", "profile": "work", "model": "sonnet", "effortLevel": "medium"
}
```

Handoff fields exactly as `POST /api/compactions` (same caps, same errors). Target fields
all optional; `profile: null` = own login; at least one must differ from the current target.

| Case | Status | Body |
|---|---|---|
| scheduled | 202 | `{status: "scheduled", sessionId, from, to, conversation: "same" \| "new", compaction: "queued" \| "skipped", resume: "accepted" \| "retrying"}` |
| not a session caller | 403 | `{error: UNIDENTIFIED_TOOL_CALL_ERROR}` |
| unknown session | 404 | as compactions |
| stopped | 409 | `{code: "stopped", error: …}` as compactions |
| terminal session | 409 | as compactions |
| invalid handoff | 400 | as compactions |
| cooldown (shared claim) | 429 | `{error, retryAt}` as compactions |
| messages queued | 409 | queued refusal, naming `switch_session` |
| target equal to current | 400 | `{code: "same-target", error: "…already runs on … — to compact without switching, use compact_session"}` |
| unknown/uninstalled engine, unknown model, unknown profile | 400 | `{code: "invalid-target", error: "… — call list_session_targets"}` |
| profile on non-claude engine | 400 | `{code: "invalid-target", …}` |
| not allowed (scoped → non-claude, remote → local profile) | 403 | `{code: "not-allowed", error: …}` |
| target out of allowance | 409 | `{code: "target-exhausted", error: "… resets at <ISO>", until}` |
| compaction turn could not be queued | 502 | as compactions; claim released, pendingSwitch removed |
| resume not recorded | 500 | as compactions |

Order (mirrors `requestCompaction`): stopped/terminal check → body → re-check → handoff
parse → target resolve → claim → queued check → write `pendingSwitch` → queue `/compact`
turn (when `compactionQueued`) → suppress stopgap callback → outbox resume with
`meta.switchResume = claimedAt`. Every failure after the claim releases it and removes
`pendingSwitch`.

## 4. MCP tools (`mcp/session-tools.ts`)

```text
list_session_targets  {}                       → GET /api/session-targets
  description: "List the engines, Claude profiles and models this session can switch to."

switch_session        {goal, done, next, context?, waitingOn?, engine?, profile?, model?, effortLevel?}
                                               → POST /api/session-switches
  description: "Compact your session and resume it on another engine, Claude profile or model (never from a Task sub-agent). End your turn after."
  returns on 202: {status: "scheduled", to, hint: "END YOUR TURN NOW, no more tool calls. …"}
```

`profile` accepts a string; `null` is passed through for own login.

## 5. Resume message (tool path)

```
[Session switch resume] You asked to move this session (switch_session). It now runs on
<Engine · profile · model>. <carry-over line>
## Goal / ## Done / ## Next / ## Context / ## Waiting on   (verbatim handoff, as compact_session)
```

Carry-over line by path:
- same conversation: "Your context was compacted in place; the summary is above in this conversation."
- summary: "This is a new conversation. The summary of the previous one follows, then your handoff." + summary block + one pointer line.
- manual handover: "This is a new conversation and the previous one could not be summarised (<reason>). Your earlier history is not repeated here: read it with read_session {sessionId: \"<id>\", last: 100} (and <transcript path> if given) before resuming."
- not applied: "The switch to <target> did not happen (<reason>); you are still on <current>. Your context was <compacted | not compacted>."
