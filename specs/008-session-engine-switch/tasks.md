---
description: "Tasks for engine and profile switching for a chat"
---

# Tasks: Engine and Profile Switching for a Chat

**Input**: spec.md, plan.md, research.md, data-model.md, contracts/api.md, quickstart.md
**Tests**: required. Every FR has a test; every refusal is tested to schedule nothing; every
new guard is tested to fail without its line.
**Paths**: `G/` = `packages/hundredfold/src/`, `W/` = `packages/web/src/`.

Format: `[ID] [P?] [Part] [Story] Description`. Parts A/B/C are plan.md's delivery parts
(each a child Todo and a PR into `feat/session-engine-switch`).

## Phase 1: Setup

- [ ] T001 [—] Create `feat/session-engine-switch` off `main` with the spec kit artefacts; open its draft PR.

## Phase 2: Foundational (Part A)

- [ ] T002 [A] `switchSessionTarget(id, opts, fence?)` in `G/sessions/registry.ts` per plan D1: park/retire, write `claude_config_dir`, clear override/`fallbackRun` (keep `fallbackHops`), clear `claudeSyncSince`/`claudeSyncAccount`/lost-conversation key, then set `engineSyncTarget/Since` + `engineSyncMode: "pointer"` unless `sync: "none"`; unfenced writes `status: "idle"`, `lastError: null`; fenced writes through `updateSessionForAttempt` with expected status `running` and leaves status/`lastError`. Delete `switchSessionEngine` and migrate its tests.
- [ ] T003 [A] `withSyncMarkersCleared` clears `engineSyncMode`; the override revert (`G/sessions/engine-override-revert.ts`) clears it when it writes a marker; `engineSyncMode`, `pendingSwitch`, `lastSwitch` join the protected keys in `G/sessions/manager.ts`.
- [ ] T004 [A] Tests `G/sessions/__tests__/switch-session-target.test.ts`: park under the own account; retire drops; override and `fallbackRun` cleared, `fallbackHops` kept; return to a parked profile resumes its id; each stale marker (`claudeSyncSince`, `claudeSyncAccount`, lost-conversation) cleared; fenced write keeps `running` and a following `completeSessionAttempt` succeeds; fenced write with a stale attempt token changes nothing; revert after a pointer switch pastes its catch-up (mode cleared); adapter merge cannot overwrite the three keys.
- [ ] T005 [A] `G/sessions/switch-target.ts` `resolveSwitchTarget` per plan D2 and research R7, including "own target" (overridden engine, own account key, null model = engine default) and coded refusals.
- [ ] T006 [P] [A] Tests `G/sessions/__tests__/switch-target.test.ts`: each refusal code; scoped session may change profile (operator and self) but not engine; remote employee refused a local profile; exhausted target refused for self, allowed for operator; `""`/`null` = own login; a declared profile sharing the employee's own directory is the same target; under an engine override the own engine is compared, not the stand-in.
- [ ] T007 [A] `G/sessions/turn/history-pointer.ts` and the `engineSyncMode === "pointer"` branch in `resolveSyncPrompt` (`G/sessions/turn/preflight.ts`); left transcript path computed before the write and stored on `lastSwitch.leftTranscript` (unscoped only).
- [ ] T008 [P] [A] Tests: pointer prompt has `read_session` with the own id, the path when given (never for a scoped session), the current message, and none of the earlier messages' text; transcript mode unchanged byte for byte; a switched session with a lost-conversation marker set beforehand still gets the pointer.
- [ ] T009 [A] `G/sessions/switch-notice.ts`: text for every `lastSwitch` shape (data-model.md); inserted as `notification` with `meta.sessionSwitch`; event emitted.

## Phase 3: US1 operator selector (P1)

- [ ] T010 [A] [US1] `G/gateway/session-target-patch.ts`: the PUT/PATCH branch for `profile` and engine changes (contracts §1), replacing the `switchSessionEngine` branch in `G/gateway/api.ts`; clears `pendingSwitch`; `claude:<name>` stays refused.
- [ ] T011 [A] [US1] Tests `G/gateway/__tests__/session-profile-switch-api.test.ts`: every row of contracts §1 (status + body keys); notice; `session:updated`; next turn runs on the new config dir with a pointer prompt (fake records it); an operator switch with a pending session switch clears it.
- [ ] T012 [P] [C] [US1] `W/lib/api.ts` `updateSession` accepts `profile?: string | null`.
- [ ] T013 [C] [US1] `W/components/chat/model-selector-row.tsx`: profiles in existing mode unless the session's employee is remote; chip label per plan D10 including "Own login"; narrow composer drops effort, then profile.
- [ ] T014 [C] [US1] `W/components/chat/chat-pane.tsx`: `allowProfiles` both modes; existing chats take `employeeRemote` from the session's own employee; seed `profile` from `claudeProfile.name`; send `profile` (`null` for own login) when changed; `model-picker.tsx` doc comment.
- [ ] T015 [P] [C] [US1] Web tests: `session-primary-profile.test.tsx` (existing-mode rows, own login row, remote session hides rows even when the new-chat employee is local), `chat-pane.test.tsx` (PUT carries `profile`, rollback on 400), `model-selector-row.test.tsx` (label forms).

## Phase 4: US2 session switch (P1, Part B)

- [ ] T020 [B] `G/gateway/self-compaction-api.ts`: move the engine check out of `compactableSession` into the plain path (no behaviour change for calls without a target; existing tests green).
- [ ] T021 [B] [US2] `G/sessions/switch-request.ts` + the branch in `requestCompaction` (plan D5): target first (refusal with `targets`, no claim), handoff, claim, queued, `pendingSwitch`, `/compact` when native, stopgap, resume; failure handling per contracts §2 (502 releases + removes; 500 keeps claim, removes, says no switch).
- [ ] T022 [B] [US2] `G/sessions/pending-switch.ts`: write/read/remove; `recordCompactionOutcome` with the match rule (focus prefix + claim time); `applyPendingSwitch` (plan D7); resume prompt (contracts §4).
- [ ] T023 [B] [US2] Outcome calls on every path in plan D6's table: `announceCompaction`, `settleRateLimitedCompaction`, `settleThrownTurn` (compaction turns).
- [ ] T024 [B] [US2] `G/sessions/compaction-summary.ts` per plan D6: Claude (`findSessionTranscript` with `result.sessionId` and the profile the turn ran on; boundary at/after turn start; ~2 s poll; `isCompactSummary`, prefix fallback; string/array content), opencode server (`summaryReport` returns text); over 24,000 characters → `summary-too-long`.
- [ ] T025 [B] [US2] `G/gateway/web-session-dispatch.ts`: pass `queueItemId` into `runWebSession`; before `maybeRevertEngineOverride`, match the delivery (`getSessionDeliveryByQueueItemId` + `selfCompactionClaimOfDelivery`) to `pendingSwitch.claimedAt` and call `applyPendingSwitch` with the attempt token; replace `request.prompt`.
- [ ] T026 [B] [US2] Stops: `stopSession` (`G/gateway/session-stop.ts`) and the dead-letter release in `G/gateway/api.ts` remove `pendingSwitch`.
- [ ] T027 [B] [US2] `compact_session` in `G/mcp/session-tools.ts`: `engine`, `profile`, `model` properties and description clause (contracts §3); handler forwards them. The gateway renders the target list into `error` (contracts §2, ≤ 1,800 characters, "+N more", `model: "?"` per engine), so `gatewayFailure` passes it through unchanged.
- [ ] T028 [B] [US2] Route tests `G/gateway/__tests__/compactions-switch-api.test.ts`: every row of contracts §2 (status + body keys); each refusal leaves target, slots, queue, claim and `pendingSwitch` unchanged (SC-004); target refusals take no claim (FR-032); a `sessionId` in the body is ignored (FR-022); codex/grok/opencode run mode switch schedules with `compaction: "skipped"` while a plain call still gets 409.
- [ ] T029 [B] [US2] Flow tests `G/sessions/__tests__/pending-switch-flow.test.ts`: summary path; each failure reason (`error`, `usage-limit`, `unconfirmed`, `no-summary`, `summary-too-long`, `no-outcome`, `not-supported`) → manual handover with no pasted transcript (SC-008) and the right reason in `lastSwitch`; same-conversation model switch; target invalid at apply; `from` changed (operator switched) → plain resume; stale resume; stop then operator `/compact` records nothing; restart between call and resume (boot replay path); resume turn settles after the apply (status fence); fallback run cleared; retired slot not resumed later.
- [ ] T030 [B] Extend `scripts/fake-providers/fake-claude.mjs` to answer `/compact` (`PostCompact`, then after a delay a `compact_boundary` and an `isCompactSummary` entry, plus `<command-name>` entries) and to fail it on a rate-limited profile; test the fake.
- [ ] T031 [P] [B] [US2] `G/sessions/__tests__/compaction-summary.test.ts` on real-shaped Claude JSONL and opencode fixtures: no boundary, boundary older than the turn (previous compaction) ignored, two boundaries, late boundary within the poll, array content, prefix fallback, over-cap.

## Phase 5: US3 target list (P2, Part B)

- [ ] T040 [B] [US3] `listSwitchTargets` in `G/sessions/switch-target.ts`; attached as `targets` to every target refusal.
- [ ] T041 [B] [US3] Tests: `targets` keys per contracts §2 for unscoped, scoped and remote sessions; property test: every listed target is accepted by `resolveSwitchTarget` (SC-005); `engine: "?"` with an invalid handoff (empty `next`) still returns the list; the rendered text stays within 1,800 characters with 60 opencode models and ends "+N more"; `model: "?"` on one engine lists only it; **MCP handler test** (`G/mcp/__tests__/session-tools.test.ts`): a 400 `invalid-target` from the gateway reaches the tool error with the list text intact.

## Phase 6: US4 visibility (P3)

- [ ] T050 [B] [US4] Notices for every outcome via T009; gateway test of the text per `carryOver` and per refusal-at-apply.
- [ ] T051 [C] [US4] Web renders `meta.sessionSwitch` notifications with the existing notification row (`W/components/chat/chat-messages.tsx`); the selector reflects a switch applied by the session without reload; web tests.

## Phase 7: Polish

- [ ] T060 [B] Manifest: buy back what dead prose allows in `G/mcp/session-tools.ts`, then rebase `MAX_MANIFEST_TOKENS`/`ATTESTED` in `tool-manifest-budget.test.ts` by the measured remainder with a paragraph; update `tool-manifest-expectations.ts` and `session-tools.test.ts`.
- [ ] T061 [B] Template `packages/hundredfold/template/CLAUDE.md` "Long sessions": switching via `compact_session` (fields, `profile: ""`, `engine: "?"` for the list, compacts first); migration copy; regenerate the unreleased bundle (`migration:generate`, `packages/hundredfold/scripts/instance-migration-bundle.mjs`).
- [ ] T062 [P] [B] Docs: `docs/session-fallback-mode.md` (profile no longer creation-only; "Switching a running session"); link from `docs/auto-compaction.md`.
- [ ] T063 [—] Integration: merge A, C, B into `feat/session-engine-switch`; full gateway and web suites (clean env, capped workers); lint; quickstart.md run with screenshots; principal QA.

## Dependencies

- T002–T009 before T010–T011 and all of Phase 4–6 gateway work.
- Part C (T012–T015, T051) needs only contracts §1 and the notice meta shape.
- T020 before T021; T030 before the T029 cases that use the fake.
- T063 last.

## Parallel

Part A and Part C run in parallel. Within Part B: T024/T031 and T030 alongside T021–T022.
