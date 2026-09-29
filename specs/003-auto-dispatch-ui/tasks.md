# Tasks: Auto-Dispatch Dashboard

**Input**: Design documents from `specs/003-auto-dispatch-ui/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md)

**Tests**: INCLUDED — constitution Principle VI; this feature is a parser, a bounded store,
a message-to-field mapping and a chart model, which is exactly what tests are required for.
The React glue is tested where it branches (empty states, refusal placement), not for markup.

**Organization**: by the plan's execution order.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable — different files, no dependency on an incomplete task
- **[Story]**: US1–US4 from spec.md

## Path Conventions

pnpm/turbo monorepo: gateway in `packages/jinn/src/`, dashboard in `packages/web/src/`, tests
in sibling `__tests__/` directories.

---

## ⚠️ Size Ratchet — an acceptance condition on every task

`pnpm ratchet --check` is red on `origin/main` for files this branch does not own. That is
not cover for a new violation. Every new file ≤ 300 lines; `gateway/api.ts` must not grow
(it shrinks here); `web/src/lib/api.ts` is not touched. Nothing is added to
`size-baseline.json` or `eslint-baseline.json` by hand.

---

## Phase 1: Foundational — one grammar, both directions

- [x] T001 `formatStartNote(record)` from the structured start record (tier, trigger, the
  verdict's windows, session, charged, cap) / `parseStartNote(body)` with the exact wording
  `recordStart` writes today; `parseMinutes` inverting `formatMinutes`; names with spaces
  and parentheses; negative minutes; a `partial` result for a body that does not fully parse
  — `packages/jinn/src/shared/idle-capacity-record.ts`
- [x] T002 `recordStart` formats through T001; wording byte-identical —
  `packages/jinn/src/gateway/idle-capacity.ts`
- [x] T003 Tests: round-trip whose input is a REAL `evaluateIdleCapacity` verdict for both
  triggers with a per-model weekly bucket; each `formatMinutes` shape; a past-reset window;
  an edited comment returns what it can, flagged; the existing loop suites stay green —
  `packages/jinn/src/shared/__tests__/idle-capacity-record.test.ts`

## Phase 2: User Story 2 — the history (P1)

- [x] T004 [US2] `listIdleCapacityStarts({ limit })`: comments by `(system, idle-capacity)`,
  live only, newest first, parsed by T001, joined with the Todo's title and status —
  `packages/jinn/src/gateway/idle-capacity-history.ts`
- [x] T005 [US2] Domain route module: `GET /api/idle-capacity` moved verbatim,
  `GET /api/idle-capacity/history?limit=` added, `GET /api/idle-capacity/policy` added
  (`{ policy, configured }` + `X-Jinn-Config-Revision`, no collector, no loop); one
  delegation line replaces the preview block in `api.ts` —
  `packages/jinn/src/gateway/idle-capacity-api.ts`, `api.ts`
- [x] T006 [US2] Tests against the real store: a start's comment appears with every field; a
  comment by another author, a tombstoned one and a non-system `idle-capacity` author do not;
  a closed Todo is still listed with its status; the policy route resolves defaults over the
  file block and carries the same revision `GET /api/config` does; the preview route still
  answers 503 without a loop and passes the existing route test —
  `packages/jinn/src/gateway/__tests__/idle-capacity-api.test.ts`

## Phase 3: User Story 3 + shell — the destination and the next tick (P3, but the shell)

- [x] T007 [P] Registrations: `APP_ROUTES`, `BASE_NAV_ITEMS` (after Limits), `routeElements`
  (lazy), `TALK_SURFACE_COVERAGE`, `BASE_STATIC_PAGES`, More tint; `nav.test.ts` overflow
  order; `docs/talk-control-coverage.md` regenerated
- [x] T008 [P] API client and types: `getIdleCapacityPreview`, `getIdleCapacityHistory`,
  `getIdleCapacityUsage`, each taking a `RequestInit` for abort —
  `packages/web/src/lib/api-idle-capacity.ts`
- [x] T008a [P] `usePolledRead(fetcher, { merge?, intervalMs, timeoutMs, tickMs })`
  extracted from `useEngineLimits` (in-flight guard, abort timeout, visibility pause and
  return, reconnect, display clock); `useEngineLimits` becomes a caller passing
  `mergeAuthoritative` and keeps every export; `use-engine-limits.test.tsx` green unchanged —
  `packages/web/src/hooks/use-polled-read.ts`, `routes/limits/use-engine-limits.ts`
- [x] T009 `useAutoDispatch()`: preview + history through one `usePolledRead` (60 s) and
  usage through another (5 min); the policy read on mount and on Reload only — never after
  a save, since adopting a revision drops a queued edit —
  `packages/web/src/routes/auto-dispatch/use-auto-dispatch.ts`
- [x] T010 [US3] Page shell + next-tick card: title, refresh button, enabled/disabled badge,
  tier + evidence (operator signal, quiet hours), reason, window readings with resets,
  `startedThisWindow / cap`, eligible count; 503 rendered as "loop not running" —
  `page.tsx`, `next-tick-card.tsx`
- [x] T011 [US2] History list: rows per T004, Todo link to `/todos/:id`, empty state, parse
  gaps rendered blank — `history-list.tsx`

## Phase 4: User Story 1 — the policy form (P1)

- [x] T012 [US1] `Config.gateway.idleCapacity` typed — `packages/web/src/routes/settings/config-shape.ts`
- [x] T013 [US1] Policy model: `policyToBlock` (every key explicit; empty label → `null`),
  field edit → next block, `problemsByField(message)` splitting the gateway's refusal on its
  key paths — `packages/web/src/routes/auto-dispatch/policy-model.ts`
- [x] T014 [US1] The form: enabled toggle; cadence, zone (datalist from
  `Intl.supportedValuesOf("timeZone")` where available), quiet hours as `type="time"`,
  opt-in label; operator detection; three tier cards with toggle, two ceilings, two
  lookaheads, cap, busy limit; toggles commit on click, every text/number field on blur or
  Enter; per-field refusal text; blank or unparseable field held locally, not written —
  `policy-form.tsx`
- [x] T015 [US1] Writes through `useConfigCommit`: seed and revision from
  `GET /api/idle-capacity/policy` in one response, `adoptRevision` before the form is
  enabled, `blocker` returning "config revision not loaded" until then; `ConfigSaveStatus`
  and `ConfigConflictNotice` reused (Reload re-reads the policy route and adopts its
  revision); a save re-fetches the PREVIEW only — the form already holds what it wrote —
  `page.tsx`
- [x] T016 [US1] Tests: `policy-model` — block round-trip, label null, refusal mapping for a
  tier path and a top-level path and an unmapped message; page — a refused save shows the
  message on the named field; a value typed but not blurred does not write; a blur writes
  once; the form refuses an edit before the revision is held; a queued edit survives the
  previous save completing (red if anything adopts a revision after a save) —
  `__tests__/policy-model.test.ts`, `__tests__/page.test.tsx`

## Phase 4b: User Story 5 — the per-Todo switch (P2)

- [x] T016a [US5] Leaf client `setTodoAutoStart(id, autoStart)` → `PUT
  /api/work-items/:id/dispatch-config` with body `{ autoStart }` only; wire type for
  `dispatchConfig` declared here since `lib/api.ts` is at budget —
  `packages/web/src/lib/api-dispatch-config.ts`
- [x] T016b [US5] `AutoStartRow` under the rail's Dispatch button: switch reading
  `detail.dispatchConfig?.autoStart ?? true`, pending state, refetch of the Todo on success,
  note when the `no-auto-start` label also applies — `routes/todos/task-page/auto-start-row.tsx`,
  one render line in `props-rail.tsx`
- [x] T016c [US5] Tests: the PUT body is exactly `{ autoStart: false }`; default reads on;
  the label note appears when the label is present — `__tests__/auto-start-row.test.tsx`

## Phase 5: User Story 4 — usage over time (P2)

- [x] T017 [US4] `recordClaudeUsageSample(snapshot, now)` on the live path only; 5h and every
  `7d*` window that carries `resetsAt` (others left out); bounded 7 d / 2 500; readings
  within 5 min of the last recorded collapsed; written whole under a per-process temporary
  name then renamed; read/write swallow their own errors —
  `packages/jinn/src/shared/claude-usage-history.ts`, one call in `engine-limits-claude.ts`
- [x] T018 [US4] `GET /api/idle-capacity/usage?hours=` in the domain module (clamped 1–168,
  default 168); the page polls it every 5 min, the sample cadence
- [x] T019 [US4] Tests: live-only, a window without a reset is left out, bounds, the
  5-minute collapse, unreadable file → empty, a torn write leaves the previous file; the
  route's `hours` clamp — `shared/__tests__/claude-usage-history.test.ts`,
  `idle-capacity-api.test.ts`
- [x] T020 [US4] Chart model: samples + starts → points on a shared time axis, reset boundaries
  where `resetsAt` changes between consecutive samples THAT CARRY the window (an untouched
  window after a roll has no 5h entry, and the marker must be found across that gap), hour
  ticks, `waiting` when < 2 samples —
  `usage-chart-model.ts` + `__tests__/usage-chart-model.test.ts`
- [x] T020a [US4] Projection model, pure with `now` injected: least-squares slope over the
  samples sharing a reset (≥ 3 samples spanning the window's minimum: 30 min for 5h, 6 h
  for a weekly bucket), line anchored at the last
  reading, `atReset` clamped at 100, `gateAt` against the ceiling of the tier the preview
  reports (label names the tier), `exhaustsAt` at 100, `flat` for a non-positive slope,
  `none` with `too-few` / `too-short`; readout wording per spec US4 sc. 4–6 with the basis
  phrase "linear, at the last <span> rate"; every `7d*` bucket projected, worst first —
  `usage-projection.ts` + `__tests__/usage-projection.test.ts` (rate from a known series;
  gate before reset; exhaustion before gate; two samples → none; integer-quantised series
  over a short span → none; a weekly bucket on 2 h of readings → none; bursty
  flat-rise-flat → slope from the fit, anchored at the last reading; non-positive over a long span → flat; scoped bucket exhausting before `7d`
  → headline names it)
- [x] T021 [US4] Card + chart: the weekly verdict as the headline (first line, largest,
  worst bucket first), the five-hour readout beneath it, then the inline SVG: 12 h tail of
  the 5h line (weekly as a second, lighter line), start markers, reset markers, dashed
  projection from the last reading to the reset, ceiling line labelled with the tier,
  accessible summary text; phone width — `usage-card.tsx`, `usage-chart.tsx`

## Phase 6: Polish

- [x] T022 `docs/idle-capacity.md`: the dashboard in "Configuration" and "Observing it"
- [ ] T023 Spec artefacts current; plan's Post-Design re-check run
- [ ] T024 Gates: `pnpm typecheck`, `pnpm lint`, `pnpm build`, targeted suites, full jinn and
  web suites; `pnpm ratchet --check` shows no violation introduced by this branch
- [x] T025 Design/plan review by senior-developer-qa round 0 (2026-09-21): REVISE FIRST —
  findings 1–13 and the projection addendum folded in; re-check of 1–5: PROCEED with the
  post-save re-read removed (T009/T015/T016) and the reset-marker rule (T020). Code review
  before the draft PR.

## Deferred (recorded, not built)

- Dropping default-equal keys from the written block — spec Open Decision 1.
- A Save button on this page — spec Open Decision 2.
- A dedicated start record beside the comment — spec Open Decision 3.
