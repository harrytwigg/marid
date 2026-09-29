# Tasks: Idle-Capacity Auto-Start

**Input**: Design documents from `specs/002-idle-capacity-auto-start/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md)

**Tests**: INCLUDED — constitution Principle VI; this feature is ceilings, lookaheads, tier
selection and boundary conditions, which is exactly what tests are required for.

**Organization**: by the plan's execution order. Status as of the second review round.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable — different files, no dependency on an incomplete task
- **[Story]**: US1–US4 from spec.md

## Path Conventions

pnpm/turbo monorepo: gateway in `packages/jinn/src/`, tests in sibling `__tests__/` directories.

---

## ⚠️ Size Ratchet — an acceptance condition on every task

`pnpm ratchet --check` is red on `origin/main` (the remote-ssh merge). That is not cover for a
new violation. Every new file ≤ 300 lines; `api.ts` must not grow (it shrinks here);
`engine-limits.ts` stays ≤ 373. Nothing is added to `size-baseline.json` or
`eslint-baseline.json` by hand.

---

## Phase 1: Foundational — one spawn, two callers

- [x] T001 Split `claimTodoForDispatch` into an HTTP-free `takeDispatchClaim` core and the route
  wrapper — `packages/jinn/src/gateway/todo-claim.ts`
- [x] T002 Extract the dispatch route's spawn recipe into `startTodoDispatcher` (plan → session →
  run), with a `promptSuffix` option — `packages/jinn/src/gateway/todo-dispatch.ts`
- [x] T003 Make `POST /api/work-items/:id/dispatch` the thin HTTP face, passing the result's
  status through unchanged (a 502 preflight stays a 502) — `packages/jinn/src/gateway/api.ts`
- [x] T004 Existing dispatch suites green after the extraction (`dispatch-route`,
  `dispatch-authority-route`, `todo-claim-routes`, `respawn-guard-trigger`)

## Phase 2: User Story 1 — the window is about to lapse (P1)

- [x] T005 [P] [US1] Policy shape, defaults, `resolveIdleCapacityPolicy`, `idleCapacityProblems`
  — `packages/jinn/src/shared/idle-capacity-config.ts`
- [x] T006 [P] [US1] `evaluateIdleCapacity`: usable-reading rules (status, stale, both windows,
  reset still ahead), per-tier ceilings incl. every `7d*` bucket, 5h and 7d triggers —
  `packages/jinn/src/shared/idle-capacity.ts`
- [x] T007 [US1] Eligibility and order: opt-out label, `autoStart: false`, non-Claude engine
  pin, pending approval, `requireLabel`; priority desc then oldest (parked Todos are `blocked`,
  so excluded by status — the separate parked rule was unreachable and removed it) —
  `packages/jinn/src/gateway/idle-capacity-backlog.ts`
- [x] T008 [US1] The loop: guards → reading → tier → busy → verdict → window ledger keyed on the
  5h reset → start via the real Dispatcher with the purpose suffix → system comment + log —
  `packages/jinn/src/gateway/idle-capacity.ts`
- [x] T009 [US1] Tests: pure verdict (`shared/__tests__/idle-capacity.test.ts`), loop guards and
  dispatching (`gateway/__tests__/idle-capacity-loop.test.ts`), incl. past reset, missing
  weekly, ledger identity across re-reads, refusal fall-through

## Phase 3: User Story 2 — tiers (P1)

- [x] T010 [US2] `localMinuteOfDay` / `isQuietHour` (IANA zone, midnight wrap) / `selectTier`
  (operator live > clock) — `packages/jinn/src/shared/idle-capacity.ts`
- [x] T011 [US2] Operator detection: operator-driven session activity + statusline mtime +
  usage-delta-outside-Jinn (tick-only reference), `idleMinutes` expiry —
  `packages/jinn/src/gateway/idle-capacity-operator.ts`, registry-backed test in
  `gateway/__tests__/idle-capacity-operator.test.ts`
- [x] T012 [US2] Per-tier `enabled`, ceilings, lookaheads, `maxDispatchesPerWindow`,
  `maxActiveSessions` applied by the loop
- [x] T013 [US2] Tests: overnight spends deep and keeps the floor; daytime holds on the same
  reading; interactive at any hour, barely acts, can be switched off; presence expiry; delta
  attribution (Jinn's own spend vs the operator's; a new window's lower number) —
  `gateway/__tests__/idle-capacity-tiers.test.ts`

## Phase 4: User Story 3 — preview (P2)

- [x] T014 [US3] `preview()` sharing the tick's guards; reports tier, operator sighting, quiet
  hours, verdict, eligible, skipped, `startedThisWindow` on every path
- [x] T015 [US3] `GET /api/idle-capacity` (503 while no loop) — `packages/jinn/src/gateway/api.ts`
- [x] T016 [US3] Route test through the real Dispatcher spawn, incl. the prompt suffix and the
  502 pass-through — `gateway/__tests__/idle-capacity-route.test.ts`

## Phase 5: User Story 4 — configuration (P2)

- [x] T017 [US4] `gateway.idleCapacity` typed and validated at config load (zone, HH:MM, tiers,
  label rule mirroring `normalizeLabelName`) — `config-types.ts`, `config.ts`
- [x] T018 [US4] Cadence read at each fire; start/stop wired in `server.ts`
- [x] T019 [US4] Timer test with fake timers (cadence re-read, clean stop)

## Phase 6: Polish

- [x] T020 OpenCode: explicit unsupported reason via `UNSUPPORTED_REASONS` —
  `packages/jinn/src/shared/engine-limits.ts`
- [x] T021 `docs/idle-capacity.md`: tiers, the precise "operator live" and "holds capacity"
  definitions, what a ceiling is and is not, config, observing
- [x] T022 Spec artefacts: this directory
- [x] T023 Gates: `pnpm typecheck`, `pnpm lint`, `pnpm build`, targeted suites, full jinn suite;
  `pnpm ratchet --check` shows no violation introduced by this branch

## Deferred (recorded, not built)

- Stop-on-ceiling for a running session — spec Open Decision 1.
- A hard Claude-engine-only rule on the Dispatcher's routing — spec Open Decision 2.
- Dashboard editing of the tiers (the ticket says "config file and/or the dashboard"): the
  config block is hot-reloaded and `PUT /api/config` already exists; a dedicated settings
  panel is a web change with its own scope.
