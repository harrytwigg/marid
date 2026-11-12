# Implementation Plan: Engine and Profile Switching for a Chat

**Branch**: `spec/session-engine-switch` (spec kit artefacts) · build on `feat/session-engine-switch`
**Date**: 2026-11-12 · **Spec**: [spec.md](spec.md)

## Summary

Make a session's Claude profile changeable after creation, behind one registry write
(`switchSessionTarget`) that both the operator's selector and a new session tool use. The
operator's path is immediate and carries history by pointer. The session's path,
`switch_session`, reuses `compact_session`'s claim, refusals, queued compaction turn and
durable resume, records a pending switch, captures the compaction's outcome and summary at
settle, and applies the switch when the resume turn starts: summary + handoff on success,
handoff + history pointer (manual handover) on failure. `list_session_targets` exposes what
the switch accepts. The web selector gains profile choice for existing chats and an
always-on engine/profile label.

## Technical Context

**Language/Version**: TypeScript, Node 24 (gateway `packages/jinn`), React + Vite (web `packages/web`)
**Primary Dependencies**: existing only (better-sqlite3, the MCP server, TanStack Query, HeroUI adapters)
**Storage**: SQLite `sessions` row and its `transport_meta` JSON; no schema change
**Testing**: vitest (gateway and web), Playwright e2e (`e2e/claude-profiles`), fake engines (`scripts/fake-providers/fake-claude.mjs`, opencode fakes)
**Target Platform**: the gateway on Linux/macOS; web in evergreen browsers
**Project Type**: monorepo, gateway + web
**Performance Goals**: no new per-turn cost when no switch is pending (one `transportMeta` key read already loaded)
**Constraints**: ESLint caps (complexity 10, 50 lines/function, 5 params, no inline disables); `gateway/api.ts` grandfathered, so new logic goes in modules; MCP manifest budget rebased with a written reason; tool descriptions one line
**Scale/Scope**: per-session; a handful of declared profiles per instance

## Constitution Check

- **I (fork-only)**: fork-local feature; nothing assumes upstream. Pass.
- **II (self-running company)**: moves a decision from the operator to the system: a session
  can move itself to the account or model with capacity (rung 3). The operator's selector
  part is rung 4 and is justified as the operator's own control and the visible check on
  rung 3. Pass.
- **III–VIII (AGENTS.md rubric)**: tests for each FR, no silent failure paths (every failed
  switch leaves a notice and a resume line), refuse rather than truncate (handoff caps
  reused), no new config keys, docs updated beside the feature. Pass.

Re-checked after design: no new gate violations.

## Design

### D1. One write for every switch (`sessions/registry.ts`)

`switchSessionTarget(id, opts)` generalises `switchSessionEngine` (kept as a thin wrapper):

1. Park the current slot under its own account (`withoutAccountOverride`), or drop it when
   `leftConversation: "retire"`.
2. Write `engine`, `claude_config_dir`, `model`, `effort_level` (a profile change with the
   same engine is a target change too).
3. Clear `engineOverride` and `fallbackRun`; keep `fallbackHops`; `lastContextTokens: null`.
4. Load the new slot (or none); set `engineSyncTarget/Since` and `engineSyncMode: "pointer"`
   unless `sync: "none"` (the tool's resume carries its own carry-over).

`withSyncMarkersCleared` also clears `engineSyncMode`.

### D2. Who may switch to what (`sessions/switch-target.ts`)

`resolveSwitchTarget(config, session, request, {caller})` returns a `SwitchTargetView` or a
coded refusal (`invalid-target | not-allowed | target-exhausted | same-target`). Rules in
research R7. Shared by the PUT branch (caller `operator`), the switch route and the list
route (`listSwitchTargets`, which enumerates the same rules so SC-005 holds by
construction: a property test feeds every listed target back through the resolver).

### D3. Operator path (`gateway/session-target-patch.ts`)

Called from the PUT/PATCH handler before today's engine branch when `profile` is present
or the engine changes. Refuses while a turn runs/waits/queues (`blocksEngineSwitch`), then
`switchSessionTarget(... "park", "pointer")`, `lastSwitch`, notice, `session:updated`.

### D4. History pointer (`sessions/turn/history-pointer.ts`, `turn/preflight.ts`)

`resolveSyncPrompt` branches on `engineSyncMode === "pointer"` to `historyPointerPrompt`
(research R6). Every other writer of a sync marker is unchanged and keeps the pasted
catch-up. The pointer names `read_session` on the session's own id and, when the left
conversation was Claude's and its transcript exists on this host
(`findTranscriptOfSession` with the left profile), that path.

### D5. Switch route and pending switch (`gateway/session-switch-api.ts`)

`handleSessionSwitchApi` serves `POST /api/session-switches` and `GET /api/session-targets`
(contracts §2–3). It reuses from `self-compaction-api.ts`: `compactableSession` checks,
`parseCompactionHandoff`, `claimSelfCompaction`/`releaseSelfCompaction`, the queued check,
`enqueueViaMessageRoute`, `suppressStopgapCallback` and the outbox delivery, which are
exported for reuse rather than copied (the delivery gains an optional `meta`). The
compaction turn is queued when the current engine compacts natively
(`compactionUnsupported` is undefined); otherwise `compactionQueued: false` and the outcome
is `not-supported`.

### D6. Compaction outcome (`sessions/turn/settle.ts` hook → `sessions/pending-switch.ts`)

At `announceCompaction` (every compaction settle path, including
`settleRateLimitedCompaction` and errors), if `pendingSwitch` exists and has no
`compaction` yet, record it: success needs `result.compaction` **and** a summary from
`readCompactionSummary` (`sessions/compaction-summary.ts`, research R2); otherwise the
matching failure reason. A same-conversation switch needs no summary (the summary is in
its own conversation): success there is `result.compaction` alone.

### D7. Apply at resume start (`gateway/web-session-dispatch.ts` → `sessions/pending-switch.ts`)

When `runWebSession` starts a turn whose meta has `switchResume === pendingSwitch.claimedAt`,
before choosing the engine: `applyPendingSwitch(session, prompt)`:

1. Re-resolve the target (config may have changed). Invalid → keep the current target,
   `lastSwitch.applied = false` with the reason.
2. Valid → `switchSessionTarget` with `leftConversation: conversation === "new" ? "retire" : "park"`,
   `sync: "none"`; for `"same"`, only model/effort change and the slot stays.
3. Build the resume prompt (contracts §5) from the pending record; replace the queued
   prompt for this turn.
4. Remove `pendingSwitch`, write `lastSwitch`, insert the notice, emit `session:updated`.

A resume whose `switchResume` does not match (stale) runs as an ordinary message.
A stop that dead-letters the resume also removes `pendingSwitch` (beside
`releaseSelfCompactionOfDelivery`).

### D8. MCP tools and teaching

`list_session_targets` and `switch_session` (contracts §4) in `mcp/session-tools.ts`.
Template `packages/jinn/template/CLAUDE.md` "Long sessions" gains three lines on switching;
the unreleased migration bundle is regenerated (state note recipe: temporary release tag).
Manifest budget rebased with a paragraph.

### D9. Web (`packages/web/src/components/chat/*`)

- `model-selector-row.tsx`: `profilesEnabled` also for `existing` (unless remote); chip label
  `Claude · <profile|Own login> · <model>` or `<Engine> · <model>`; effort drops first on
  narrow composers (existing container query), then profile.
- `chat-pane.tsx`: `allowProfiles` for both modes; seed `profile` from
  `session.claudeProfile?.name`; send `profile` (`null` for own login) when it changed;
  error/pending handling unchanged.
- `lib/api.ts`: `updateSession` body type gains `profile?: string | null`.
- Switch notices render as notifications (meta `sessionSwitch`) with the existing
  notification row; no new component unless the hop card pattern is wanted (not required).

### D10. Docs

`docs/session-fallback-mode.md` "Starting on a chosen profile": the at-creation-only rule
becomes "and later from the selector or `switch_session`"; new section "Switching a running
session" (operator path, tool path, carry-over, refusals). `docs/auto-compaction.md` links it.

## Delivery

Integration branch `feat/session-engine-switch` off `main` (after the spec PR merges or on
top of it). Three parts, each its own child Todo for the senior, each its own PR into the
integration branch, each QA'd by the senior QA (principal QA for Part B, which carries the
compaction/resume ordering: hard to undo once sessions depend on it):

| Part | Scope | Depends on |
|---|---|---|
| A. Target write + operator path | D1, D2 (resolver, no list), D3, D4, notice helper, PUT tests | — |
| B. Switch tool | D2 list, D5, D6, D7, D8, D10 | A merged into integration |
| C. Web selector | D9 | contract §1 only (builds against it; verified against A) |

A and C run in parallel; B follows A. The principal integrates, runs the full suite and the
functional run (quickstart.md), and sends the integration PR to principal QA.

## Project Structure

```text
specs/008-session-engine-switch/
├── spec.md · plan.md · research.md · data-model.md · quickstart.md · tasks.md
├── contracts/api.md
└── checklists/requirements.md

packages/jinn/src/
├── sessions/registry.ts                 (switchSessionTarget; withSyncMarkersCleared)
├── sessions/switch-target.ts            (new: resolveSwitchTarget, listSwitchTargets)
├── sessions/pending-switch.ts           (new: record outcome, applyPendingSwitch, resume prompt)
├── sessions/compaction-summary.ts       (new: readCompactionSummary)
├── sessions/switch-notice.ts            (new: notice text + insert)
├── sessions/turn/history-pointer.ts     (new)
├── sessions/turn/preflight.ts           (pointer branch)
├── sessions/turn/settle.ts              (outcome hook)
├── gateway/session-target-patch.ts      (new: operator PUT branch)
├── gateway/session-switch-api.ts        (new: two routes)
├── gateway/self-compaction-api.ts       (exports for reuse; delivery meta)
├── gateway/web-session-dispatch.ts      (apply hook)
├── gateway/department-scope/rules.ts    (two pass rows)
├── gateway/api.ts                       (dispatch lines only)
└── mcp/session-tools.ts                 (two tools)
packages/web/src/components/chat/{model-selector-row,chat-pane,model-picker}.tsx, lib/api.ts
packages/jinn/template/CLAUDE.md (+ migration copy), docs/session-fallback-mode.md, docs/auto-compaction.md
```

## Complexity Tracking

| Choice | Why | Simpler alternative rejected because |
|---|---|---|
| Apply at resume start, not at compaction settle | a stop between the two must withdraw the switch, and the resume prompt depends on the outcome | applying at settle cannot see a later stop and has no prompt to rewrite |
| `engineSyncMode` flag instead of changing the catch-up globally | the operator scoped "no pasted transcripts" to this feature's switches; fallback hops keep theirs | a global change alters fallback behaviour outside the spec |
| Summary read-back per engine | the operator chose native compaction on the old target; the summary is the only thing worth carrying | carrying nothing wastes the compaction turn |
