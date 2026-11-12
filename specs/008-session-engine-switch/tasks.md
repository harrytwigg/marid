---
description: "Tasks for engine and profile switching for a chat"
---

# Tasks: Engine and Profile Switching for a Chat

**Input**: spec.md, plan.md, research.md, data-model.md, contracts/api.md, quickstart.md
**Tests**: required. Every FR has at least one test; refusals are tested to schedule nothing.
**Paths**: `G/` = `packages/jinn/src/`, `W/` = `packages/web/src/`.

Format: `[ID] [P?] [Part] [Story] Description`. Parts A/B/C are the delivery parts in
plan.md (each a child Todo and PR into `feat/session-engine-switch`).

## Phase 1: Setup

- [ ] T001 [—] Create integration branch `feat/session-engine-switch` off `main` with the spec kit artefacts merged; open its draft PR.

## Phase 2: Foundational (Part A; blocks US1 operator path and all of Part B)

- [ ] T002 [A] Add `switchSessionTarget(id, opts)` to `G/sessions/registry.ts` per plan D1 (park/retire, write `claude_config_dir`, clear `engineOverride`/`fallbackRun`, keep `fallbackHops`, sync marker with `engineSyncMode`); make `switchSessionEngine` a wrapper with unchanged behaviour (`engineSyncMode` absent). Extend `withSyncMarkersCleared` to clear `engineSyncMode`.
- [ ] T003 [A] Tests in `G/sessions/__tests__/switch-session-target.test.ts`: profile change parks the old Claude slot under its own account; retire drops it; override and fallbackRun cleared, fallbackHops kept; return to a parked profile resumes its id; existing `switchSessionEngine` tests still pass unchanged.
- [ ] T004 [A] `G/sessions/switch-target.ts` `resolveSwitchTarget` per research R7 with coded refusals (`invalid-target`, `not-allowed`, `target-exhausted` (self only), `same-target` (self only)); reuse `parsePrimaryEngine`, `scopedSwitchRefusal`, `validateNewSessionSelection`, availability and health helpers.
- [ ] T005 [P] [A] Tests `G/sessions/__tests__/switch-target.test.ts`: every refusal code; scoped session may change profile (both callers) but not engine; remote employee refused a local profile; exhausted target refused for self, allowed for operator; own login (`profile: null`) accepted.
- [ ] T006 [A] `G/sessions/turn/history-pointer.ts` `historyPointerPrompt({sessionId, since?, transcriptPath?, message})` and the `engineSyncMode === "pointer"` branch in `G/sessions/turn/preflight.ts` `resolveSyncPrompt`.
- [ ] T007 [P] [A] Tests: pointer prompt contains `read_session` with the own id, the transcript path when given, the current message, and **none** of the earlier messages' text; transcript mode (marker without `engineSyncMode`) unchanged byte for byte (`G/sessions/turn/__tests__/history-pointer.test.ts`, extend the preflight tests).
- [ ] T008 [A] `G/sessions/switch-notice.ts`: notice text for every `lastSwitch` shape in data-model.md, inserted as `notification` with `meta.sessionSwitch`, emitting the existing notification event.

## Phase 3: US1 operator selector (P1)

- [ ] T010 [A] [US1] `G/gateway/session-target-patch.ts`: the PUT/PATCH branch for `profile` and engine changes (contracts §1); wire it into `G/gateway/api.ts` before today's engine branch; keep `claude:<name>` refused.
- [ ] T011 [A] [US1] Gateway tests `G/gateway/__tests__/session-profile-switch-api.test.ts`: every row of contracts §1 (status + body keys); notice written; `session:updated` emitted; next turn runs with the new config dir and a pointer prompt (fake engine records the prompt).
- [ ] T012 [P] [C] [US1] `W/lib/api.ts` `updateSession` accepts `profile?: string | null`.
- [ ] T013 [C] [US1] `W/components/chat/model-selector-row.tsx`: profiles in existing mode (not for remote employees); chip label per plan D9 including "Own login"; narrow composer drops effort first.
- [ ] T014 [C] [US1] `W/components/chat/chat-pane.tsx`: `allowProfiles` both modes; seed `profile` from `claudeProfile.name`; send `profile` (`null` for own login) when changed; existing pending/error handling; `model-picker.tsx` doc comment updated.
- [ ] T015 [P] [C] [US1] Web tests: `session-primary-profile.test.tsx` (existing-mode picker rows, own login row, remote hides rows, label forms), `chat-pane.test.tsx` (PUT body carries `profile`, rollback on 400), `model-selector-row.test.tsx` (chip label with and without profiles).

## Phase 4: US2 switch tool (P1, Part B)

- [ ] T020 [B] Export the reusable pieces of `G/gateway/self-compaction-api.ts` (compactable check, queued refusal builder, stopgap suppression, outbox resume with optional `meta`) without behaviour change; its tests stay green.
- [ ] T021 [B] [US2] `G/sessions/pending-switch.ts`: write/read/remove `pendingSwitch`; `recordCompactionOutcome`; `applyPendingSwitch` (plan D7); resume prompt builder (contracts §5).
- [ ] T022 [B] [US2] `G/sessions/compaction-summary.ts` `readCompactionSummary(session, engine)`: Claude transcript (first user entry after newest `compact_boundary`), opencode server summary message text; 16,000-character cap; nothing for other engines.
- [ ] T023 [B] [US2] Hook in `G/sessions/turn/settle.ts` `announceCompaction` (all settle paths including `settleRateLimitedCompaction`, errors, stops) → `recordCompactionOutcome`.
- [ ] T024 [B] [US2] Hook in `G/gateway/web-session-dispatch.ts` `runWebSession`: matching `meta.switchResume` → `applyPendingSwitch` before engine choice; stale or missing → ordinary message.
- [ ] T025 [B] [US2] Stop path: where a stop dead-letters a self-compaction resume (`releaseSelfCompactionOfDelivery` caller in `G/gateway/api.ts`), also remove `pendingSwitch`.
- [ ] T026 [B] [US2] `G/gateway/session-switch-api.ts` `POST /api/session-switches` (contracts §3, order as listed); dispatch in `G/gateway/api.ts`; pass row in `G/gateway/department-scope/rules.ts`.
- [ ] T027 [B] [US2] `switch_session` tool in `G/mcp/session-tools.ts` (contracts §4).
- [ ] T028 [B] [US2] Route tests `G/gateway/__tests__/session-switch-api.test.ts`: every row of contracts §3 (status + body keys); each refusal leaves target, slots, queue, claim and `pendingSwitch` unchanged (SC-004).
- [ ] T029 [B] [US2] Flow tests `G/sessions/__tests__/pending-switch-flow.test.ts`: summary path, each failure reason → manual handover (no pasted transcript, SC-008), same-conversation model switch, engine without native compaction, target invalid at apply, stale resume, stop between call and resume, gateway restart between (re-read from durable state), fallback run cleared, retired slot not resumed later.
- [ ] T030 [B] Extend `scripts/fake-providers/fake-claude.mjs` to answer `/compact` (PostCompact hook, `compact_boundary` and a summary user entry in the transcript) and to fail it on a rate-limited profile; test the fake.
- [ ] T031 [P] [B] [US2] `G/sessions/__tests__/compaction-summary.test.ts` on real-shaped Claude JSONL and opencode summary fixtures, including no boundary, two boundaries (newest wins), over-cap.

## Phase 5: US3 list tool (P2, Part B)

- [ ] T040 [B] [US3] `listSwitchTargets` in `G/sessions/switch-target.ts` and `GET /api/session-targets` in `G/gateway/session-switch-api.ts` (contracts §2); pass row in rules.
- [ ] T041 [B] [US3] `list_session_targets` tool in `G/mcp/session-tools.ts`.
- [ ] T042 [B] [US3] Tests: response keys per contracts §2 for unscoped, scoped and remote sessions; every listed target accepted by `resolveSwitchTarget` (SC-005, property over fixtures); scoped caller sees profiles.

## Phase 6: US4 visibility (P3)

- [ ] T050 [B] [US4] Notices for every tool outcome via T008; web renders `meta.sessionSwitch` notifications with the existing notification row (`W/components/chat/chat-messages.tsx`); test the text for each `carryOver`.
- [ ] T051 [C] [US4] Selector reflects a switch applied by the tool without reload (session refetch on `session:updated`); web test.

## Phase 7: Polish

- [ ] T060 [B] MCP pins: `tool-manifest-budget.test.ts` (rebase with a paragraph, count 53), `tool-manifest-expectations.ts`, `server.test.ts`, `session-tools.test.ts`, `department-scope-belt.test.ts`.
- [ ] T061 [B] Template `packages/jinn/template/CLAUDE.md` "Long sessions": when to use `switch_session` / `list_session_targets`; migration copy; regenerate the unreleased bundle.
- [ ] T062 [P] [B] Docs: `docs/session-fallback-mode.md` (profile no longer creation-only; new "Switching a running session"), link from `docs/auto-compaction.md`.
- [ ] T063 [—] Integration: merge A, C, B into `feat/session-engine-switch`; full gateway + web suites (clean env, capped workers); lint; quickstart.md functional run with screenshots; principal QA.

## Dependencies

- T002–T008 before T010–T011 and all of Phase 4–6 gateway work.
- Part C (T012–T015, T051) needs only contracts §1; it can start with Part A.
- T020 before T021–T028; T030 before the T029 cases that use the fake.
- T063 last.

## Parallel

Part A and Part C run in parallel. Within Part B: T022/T031 and T030 alongside T021.
