# Implementation Plan: Engine and Profile Switching for a Chat

**Branch**: `spec/session-engine-switch` (spec kit artefacts) · build on `feat/session-engine-switch`
**Date**: 2026-11-12 (revised after spec review) · **Spec**: [spec.md](spec.md)

## What already exists (Principle VII)

Lines verified against `origin/main` at `f5334300`. `G/` = `packages/hundredfold/src/`,
`W/` = `packages/web/src/`.

| `path:line` | What it is | Used / rejected |
|---|---|---|
| `G/mcp/session-tools.ts:399` | `compact_session` tool: handoff fields, `POST /api/compactions` | **extended** with `engine`, `profile`, `model` |
| `G/gateway/self-compaction-api.ts:191` | `requestCompaction`: check, body, re-check, handoff, claim, queued refusal, `/compact` turn, resume | **reused**; a switch branches inside it |
| `G/gateway/self-compaction-api.ts:120` | `compactableSession` (stopped, terminal, engine checks) | reused; its engine check (`:136`) moves out so a switch can skip it |
| `G/gateway/self-compaction-api.ts:98` | `deliverResumeViaOutbox`: `deliveryKind: "self-compaction-resume"`, `sourceAttempt: "self-compaction:<at>"` | reused unchanged |
| `G/gateway/self-compaction-api.ts:231` | `suppressStopgapCallback` | reused unchanged |
| `G/sessions/self-compaction.ts:97` | `parseCompactionHandoff` (caps, refuse not truncate) | reused |
| `G/sessions/self-compaction.ts:113` | `compactionUnsupported(engine, opencodeMode)` | decides whether a switch queues a compaction |
| `G/sessions/self-compaction.ts:147` | `SELF_COMPACTION_FOCUS_PREFIX` | tells a self-compaction turn from an operator's `/compact` |
| `G/sessions/self-compaction.ts:167` | `buildResumeMessage` | the payload a stale or unmatched resume still delivers |
| `G/sessions/registry.ts:916` | `claimSelfCompaction` (cooldown claim in `transportMeta.selfCompactionAt`) | reused |
| `G/sessions/registry.ts:948` | `selfCompactionClaimOfDelivery` (claim time from a delivery row) | **matches a resume to its pending switch** |
| `G/sessions/registry.ts:957` | `releaseSelfCompactionOfDelivery` (stop dead-letters a resume) | also clears the pending switch |
| `G/sessions/registry.ts:2509` | `getSessionDeliveryByQueueItemId` | finds the delivery behind a starting turn |
| `G/sessions/registry.ts:1137` | `switchSessionEngine`: parks the slot, writes engine/model/effort, clears override and `fallbackRun`, sets `status: "idle"`, `lastError: null` | **replaced** by `switchSessionTarget`; its only production caller is `G/gateway/api.ts:1955`, which D3 replaces |
| `G/sessions/registry.ts:1024` | `updateSessionForAttempt` (write fenced on attempt + status) | the in-turn apply writes through it |
| `G/sessions/registry.ts:1045` | `completeSessionAttempt` (settle fenced on status `running`) | why the apply must leave status alone |
| `G/sessions/registry.ts:565` | `UpdateSessionFields` (no `claudeConfigDir`) | unchanged; the profile is written only by `switchSessionTarget` |
| `G/sessions/engine-override.ts:135` | `beginEngineSubstitution`: precedent for an in-turn target change via `updateSessionForAttempt` | pattern followed |
| `G/sessions/session-account.ts:136` | `threadSlot` (engine, or Claude account key) | unchanged; the slot follows `claudeConfigDir` |
| `G/sessions/session-account.ts:90` | `ownClaudeAccount` (own login = employee's own profile, else `claude`) | "own target" for same-target checks |
| `G/sessions/session-account.ts:172` | `withoutAccountOverride` | parks the left slot under its own account |
| `G/sessions/primary-profile.ts:68` | `resolvePrimaryEngine` (creation-time profile refusals: scoped caller 403, remote 400) | rejected for switching (scoped sessions may switch profiles); its parse `:29` reused |
| `G/sessions/scoped-engine.ts:31` | `scopedSwitchRefusal` (scoped sessions stay on claude) | reused |
| `G/sessions/session-patch.ts:50` | `validateNewSessionSelection` | reused for engine/model |
| `G/sessions/availability-registry.ts:11` | `engineInstalledWhereRun` | reused for "installed where the session runs" |
| `G/shared/claude-accounts-config.ts:108` | `declaredClaudeAccounts` | reused |
| `G/shared/engine-health-store.ts:93`, `G/shared/engine-health.ts:52`, `G/shared/fallback-chain-health.ts:36` | health reading, per-target filter, health key | "target out of allowance" |
| `G/sessions/turn/preflight.ts:239` | `resolveTurnPrompt`: lost-conversation branch first (`:35` key), then `resolveSyncPrompt` `:291` via `syncSince` `:271` | pointer branch added; switch clears the markers that would pre-empt it |
| `G/sessions/turn/preflight.ts:405` | `withSyncMarkersCleared` | also clears `engineSyncMode` |
| `G/sessions/turn/sync-transcript.ts:19` | `syncTranscriptPrompt` (pastes the last 20 messages) | **rejected** for this feature's switches; kept for fallback paths |
| `G/sessions/engine-override-revert.ts:76`, `:85` | override revert writes `claudeSyncSince` / `engineSyncTarget` | must clear `engineSyncMode` |
| `G/sessions/manager.ts:68` | internal `transportMeta` keys protected from adapter merges | gains `engineSyncMode`, `pendingSwitch`, `lastSwitch` |
| `G/sessions/turn/runner.ts:277` | a limited compaction turn never walks a fallback chain | relied on; no change |
| `G/sessions/turn/settle.ts:120` | `settleRateLimitedCompaction` | records `usage-limit` |
| `G/sessions/turn/settle.ts:153`, `:168`, `:189` | `settleAnsweredTurn` → `announceCompaction` (skipped when quietly pre-empted; returns early on error) | records success / `unconfirmed` / `error` |
| `G/sessions/turn/settle.ts:306` | `settleThrownTurn` | records `error` |
| `G/sessions/turn/completion.ts:75` | `settleTurn` | not used: outcome is recorded per path above, with a resume-time default for the rest |
| `G/engines/claude-interactive.ts:2557` | `PostCompact` sets `result.compaction` | success signal |
| `G/engines/claude-interactive.ts:180`, `:221` | `compactionStatsFromTranscript(path, afterMs)`, `awaitCompactionStats` (polls ~2 s for `compact_boundary`) | pattern for the summary reader |
| `G/engines/opencode-server-compaction.ts:65` | `summaryReport` (locates the `summary: true` message; reads cost/tokens only) | extended to return text |
| `G/gateway/session-claude-profile.ts:25` | `findTranscriptOfSession` (profile from the session row) | rejected for the summary (wrong profile after an override); `G/engines/claude-transcript-path.ts:36` `findSessionTranscript(id, profile, cwd)` used directly |
| `G/gateway/web-session-dispatch.ts:122`, `:179`, `:195` | `dispatchWebSessionRun` (has `queueItemId`), `runWebSession` (does not), `maybeRevertEngineOverride` | `queueItemId` passed through; apply runs before the revert |
| `G/gateway/callback-queue-recovery.ts:85` | boot replay goes through `dispatchWebSessionRun` | same path after a restart |
| `G/sessions/queue-stop.ts:26` | `withdrawPendingQueueItemsForStop` (cancels queued rows, no release) | stop must also clear the pending switch |
| `G/gateway/session-stop.ts:83` | `stopSession` | clears the pending switch and releases nothing else |
| `G/gateway/api.ts:1937`, `:1943`, `:1955` | PUT refuses `claude:<name>`; refuses while a turn runs; calls `switchSessionEngine` | D3 replaces the switch branch |
| `G/gateway/department-scope/rules.ts:95` | `/api/compactions` passes for scoped callers | no new route, no new row |
| `G/mcp/__tests__/tool-manifest-budget.test.ts:11`, `:303` | `MAX_MANIFEST_TOKENS = 4371`; Pi attested at 4371 | see Constitution Check IV |
| `G/mcp/__tests__/context-diet.test.ts:9` | "a read tool that shrinks no prompt does not ship" | why there is no list tool |
| `W/components/chat/model-selector-row.tsx:230` | `profilesEnabled` only in `new` mode | lifted |
| `W/components/chat/chat-pane.tsx:613`, `:615` | `allowProfiles={!sessionId}`, `employeeRemote={selectedEmployeeRemote}` (new-chat employee) | both changed for existing chats |
| `W/lib/api.ts:669` | `updateSession` body type | gains `profile` |
| `packages/hundredfold/template/CLAUDE.md:72` | "Long sessions: self-compaction" teaching | gains the switch |
| `docs/session-fallback-mode.md:71` | "Starting on a chosen profile" (creation-only) | updated |

## Summary

Make a session's Claude profile changeable after creation behind one registry write,
`switchSessionTarget`, used by the operator's selector and by a session's own switch. The
operator's path is immediate and carries history by pointer. A session switches by calling
`compact_session` with up to three target fields: the request reuses the compaction route,
claim, refusals, `/compact` turn and durable resume; records a pending switch; captures the
compaction's outcome and summary at each settle path; and applies the switch when the
resume turn starts: summary + handoff on success, handoff + history pointer on failure. Any
target refusal carries the list of valid targets, so there is no separate list tool. The web
selector gains profile choice for existing chats and an always-on engine/profile label.

## Technical Context

**Language/Version**: TypeScript, Node 24 (gateway `packages/hundredfold`), React + Vite (web `packages/web`)
**Primary Dependencies**: existing only
**Storage**: SQLite `sessions` row and `transport_meta` JSON; no schema change
**Testing**: vitest (gateway, web), Playwright e2e (`e2e/claude-profiles`), fake engines (`scripts/fake-providers/`)
**Project Type**: monorepo, gateway + web
**Performance Goals**: no new per-turn cost without a pending switch (one already-loaded `transportMeta` key)
**Constraints**: ESLint caps (complexity 10, 50 lines/function, 5 params, no inline disables); `G/gateway/api.ts` is grandfathered, so new logic goes in modules; manifest budget per Constitution IV

## Constitution Check

- **I (fork-only)**: pass.
- **II (self-running company)**: a session can move itself to the account or model with capacity
  (rung 3: closes a loop the operator closes by hand). The selector part is rung 4, kept as the
  operator's own control and the visible check on rung 3.
- **IV (footprint ladder)**: **rung 1, extend `compact_session`.** Measured with the test's own
  tokenizer (`js-tiktoken` o200k, `tool-manifest-budget.test.ts`), largest wrapper Pi:
  - today: 4,371 against `MAX_MANIFEST_TOKENS = 4371` (`:11`; attested `:303`);
  - `compact_session` + optional `engine`, `profile`, `model` (strings) and the description
    clause ", optionally on another engine/profile/model": **4,399 (+28)**; RPC 4,064 (+28),
    OpenAI 4,203 (+28);
  - rejected: two new core tools (`switch_session` with the handoff and four target fields,
    `list_session_targets` with none): **4,539 (+168)**, six times the cost, and the list tool
    is a read tool that shrinks no prompt (`context-diet.test.ts:9`).
  - Rungs 2–4 for the list: a CLI command or skill cannot see the caller's verified session
    identity or its scope; a gated or out-of-process tool still adds a read tool. Carrying the
    list on the refusal costs nothing in the manifest.
  - `effortLevel` is left off the tool (another ~8 tokens): effort follows the target's last
    or default level, and the operator's selector sets it.
  - The +28 is paid first from any dead prose found in `session-tools.ts` descriptions; the
    ceiling moves only by the remainder, with a paragraph in the test (task T060).
- **V (no speculative infrastructure)**: `switchSessionEngine` is deleted, not kept beside its
  replacement; no new config keys; no list route.
- **VI (tests can fail for a reason)**: each refusal, settle path and marker has a test that
  fails without its line (tasks name them).
- **VII**: table above; re-verified before handover.

## Design

### D1. One write for every switch (`G/sessions/registry.ts`)

`switchSessionTarget(id, opts, fence?)` replaces `switchSessionEngine`:

1. Park the current slot under its own account (`withoutAccountOverride`), or drop it when
   `leftConversation: "retire"`.
2. Write `engine`, `claude_config_dir`, `model`, `effort_level`.
3. Clear `engineOverride` and `fallbackRun` (keep `fallbackHops`); `lastContextTokens: null`.
4. Clear every catch-up marker that could pre-empt or redirect the new slot's first prompt:
   `claudeSyncSince`, `claudeSyncAccount`, the lost-conversation key, `engineSyncTarget/Since`.
5. Then, unless `sync: "none"`, set `engineSyncTarget/Since` and `engineSyncMode: "pointer"`.
6. Without `fence` (operator path, session idle): write as `switchSessionEngine` did,
   `status: "idle"`, `lastError: null`. With `fence` (`{attemptToken}`, in-turn apply): write
   through `updateSessionForAttempt` with expected status `running`, leaving status and
   `lastError` untouched, as `beginEngineSubstitution` does.

Also: the override revert (`engine-override-revert.ts:76`, `:85`) clears `engineSyncMode`
whenever it writes a marker, and `withSyncMarkersCleared` clears it on settle. `engineSyncMode`,
`pendingSwitch` and `lastSwitch` join the protected keys at `G/sessions/manager.ts:68`.

### D2. Who may switch to what (`G/sessions/switch-target.ts`)

`resolveSwitchTarget(config, session, request, {caller})` → `SwitchTargetView` or a coded
refusal; `listSwitchTargets(config, session)` enumerates the same rules (SC-005 is a
property test feeding every listed target back through the resolver).

- **Own target**: the session's own engine (under an engine override, the overridden one, not
  the stand-in), its own Claude account key (`ownClaudeAccount`), its model with `null` read as
  the engine's default. Profiles are compared by account key, so a declared profile sharing the
  employee's own directory is the same target.
- Rules: research R7. Codes: `invalid-target`, `not-allowed`, `target-exhausted` (self only),
  `same-target` (self only).

### D3. Operator path (`G/gateway/session-target-patch.ts`)

Called from the PUT/PATCH handler in place of the `switchSessionEngine` branch
(`api.ts:1940-1964`) whenever the engine or `profile` changes: refuse while a turn runs, waits
or queues; `switchSessionTarget(... "park", "pointer")`; **clear any `pendingSwitch`** (the
operator's choice wins; the session's later resume then runs as a plain resume); `lastSwitch`;
notice; `session:updated`.

### D4. History pointer (`G/sessions/turn/history-pointer.ts`, `preflight.ts`)

`resolveSyncPrompt` branches on `engineSyncMode === "pointer"` to `historyPointerPrompt`. The
pointer names `read_session` on the session's own id (with `last: 100`; up to 500) and, for an
unscoped session whose left conversation was Claude's, that transcript's path, computed
**before** the target write from the left engine session id, the left profile and
`transcriptCwd` (`findSessionTranscript`) and stored on `lastSwitch.leftTranscript`.
A department-scoped session gets `read_session` only.

### D5. The switch request (`G/gateway/self-compaction-api.ts` + `G/sessions/switch-request.ts`)

`requestCompaction` gains a branch when any of `engine`, `profile`, `model` is present:

1. `compactableSession` without its engine check (the check moves to the plain path).
2. Read body; re-check.
3. **Target first**: `resolveSwitchTarget`; refusal → its status and code, with `targets` (FR-032:
   before the handoff, no claim).
4. Handoff parse; claim; queued refusal (wording "…then call compact_session again").
5. Write `pendingSwitch` (data-model.md).
6. If the current engine compacts natively, queue the `/compact` turn as today; else
   `compactionQueued: false`.
7. Stopgap suppression; outbox resume with `buildResumeMessage(handoff)` as its payload.

Failures after the claim: a refused or failed `/compact` enqueue releases the claim and removes
`pendingSwitch` (as compactions release today). A resume that cannot be recorded (500): the
compaction is queued and runs (claim kept, as compactions); `pendingSwitch` is removed; the
body says the compaction will run and **no switch was scheduled**.

### D6. Compaction outcome (`G/sessions/pending-switch.ts`)

`recordCompactionOutcome(sessionId, outcome)` sets `pendingSwitch.compaction` only when a
pending switch exists, has no outcome yet, and the turn is that switch's compaction (its
prompt starts `/compact ` + `SELF_COMPACTION_FOCUS_PREFIX` and the turn began after
`claimedAt`). Called from:

| Path | Outcome |
|---|---|
| `announceCompaction` (`settle.ts:189`), confirmed (`result.compaction` set) | same conversation: `ok`; new conversation: `ok` with summary, else `no-summary` |
| `announceCompaction`, unconfirmed / `result.error` | `unconfirmed` / `error` |
| `settleRateLimitedCompaction` (`:120`) | `usage-limit` |
| `settleThrownTurn` (`:306`) for a compaction turn | `error` |
| quietly pre-empted (`:168`), preflight refusal, restart cut-off | none recorded; resume-time default `no-outcome` |

Summary read (`G/sessions/compaction-summary.ts`, called with the turn's own result):
- Claude: transcript path from `findSessionTranscript(result.sessionId, <profile the turn ran on, override included>, transcriptCwd)`; poll up to ~2 s (as `awaitCompactionStats`) for a `compact_boundary` written at or after the compaction turn started; the summary is the first entry after it with `isCompactSummary: true`, else the first user entry whose text starts "This session is being continued from a previous conversation"; content may be a string or an array of text parts.
- opencode server: `summaryReport` returns the `summary: true` message's text parts too.
- Otherwise none.
- Over 24,000 characters: not truncated; recorded as `summary-too-long` and the switch takes
  the manual handover (refuse rather than truncate).

### D7. Apply at resume start (`G/gateway/web-session-dispatch.ts` → `G/sessions/pending-switch.ts`)

`dispatchWebSessionRun` passes its `queueItemId` into `runWebSession`. At the top of
`runWebSession`, **before `maybeRevertEngineOverride`**: if the queue item's delivery
(`getSessionDeliveryByQueueItemId`) is a self-compaction resume whose claim
(`selfCompactionClaimOfDelivery`) equals `pendingSwitch.claimedAt`, call
`applyPendingSwitch(session, attemptToken)`:

1. Check `from` still equals the session's own target and re-resolve `to`. Either fails → no
   switch; `lastSwitch.applied = false` with the reason.
2. Else `switchSessionTarget(to, {leftConversation: conversation === "new" ? "retire" : "park", sync: "none"}, {attemptToken})`; for `"same"` only model/effort change.
3. Build the resume prompt (contracts §4) and replace `request.prompt`.
4. Remove `pendingSwitch`, write `lastSwitch`, insert the notice, emit `session:updated`.

Then the revert check and engine pick run on the switched row. A resume whose claim does not
match (stale, or the operator switched meanwhile) runs its payload as a plain resume. Both live
runs and boot replay (`callback-queue-recovery.ts:85`) come through here.

### D8. Stops

`stopSession` (`session-stop.ts:83`) and the dead-letter release (`api.ts:3906`) both remove
`pendingSwitch`, so a later operator `/compact` can never record onto it.

### D9. MCP and teaching

`compact_session` (`session-tools.ts:399`): three optional string properties and the
description clause; the handler forwards them. Template `CLAUDE.md:72` gains: how to switch
(fields, `profile: ""` for own login, `engine: "?"` to get the list) and that the switch
compacts first. The unreleased migration bundle is regenerated with the repo's
`migration:generate` script (`packages/hundredfold/package.json:35`, `packages/hundredfold/scripts/instance-migration-bundle.mjs`).

### D10. Web (`W/components/chat/*`)

- `model-selector-row.tsx`: `profilesEnabled` in both modes unless the session's employee is
  remote; chip label `Claude · <profile|Own login> · <model>` or `<Engine> · <model>`; on a narrow
  composer effort drops first, then the profile.
- `chat-pane.tsx`: `allowProfiles` both modes; for an existing chat `employeeRemote` comes from
  the session's own employee, not the new-chat selection; seed `profile` from
  `claudeProfile.name`; send `profile` (`null` for own login) when changed.
- `lib/api.ts:669`: `profile?: string | null`.
- Notices with `meta.sessionSwitch` render through the existing notification row.

### D11. Docs

`docs/session-fallback-mode.md:71`: a profile is no longer creation-only; new section "Switching
a running session" (selector, `compact_session` targets, carry-over, refusals);
`docs/auto-compaction.md` links it.

## Delivery

Integration branch `feat/session-engine-switch` off `main` once the spec PR merges. Three
parts, each a child Todo for the senior and a PR into the integration branch:

| Part | Scope | Depends on | QA |
|---|---|---|---|
| A. Target write + operator path | D1, D2 (resolver), D3, D4, notice helper | — | senior QA |
| B. Session switch | D2 list, D5–D9, D11 | A merged | principal QA (compaction/resume ordering) |
| C. Web selector + notices | D10 | contracts §1 only | senior QA |

A and C run in parallel; B follows A. The principal integrates, runs the full suites and the
quickstart.md run, and sends the integration PR to principal QA.

## Complexity Tracking

| Choice | Why | Rejected alternative |
|---|---|---|
| Extend `compact_session` | +28 manifest tokens | two tools, +168 (Constitution IV) |
| List on refusal | zero manifest cost, always current | a read tool that shrinks no prompt |
| Apply at resume start, fenced write | a stop between the turns must withdraw it; the resume prompt depends on the outcome; status must stay `running` for the settle | apply at compaction settle (no later stop, no prompt) |
| `engineSyncMode` beside the existing markers | the "no pasted transcript" rule covers this feature's switches, not fallback hops | changing the catch-up globally |
| Outcome recorded per settle path | `announceCompaction` is not reached by limits, throws or pre-emption | one hook there (wrong reasons, FR-015c) |
