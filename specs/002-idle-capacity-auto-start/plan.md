# Implementation Plan: Idle-Capacity Auto-Start

**Branch**: `feat/idle-capacity-auto-start` | **Date**: 2026-09-20 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/002-idle-capacity-auto-start/spec.md`

## Existing Infrastructure *(Principle VII — opens the plan)*

Verified against the worktree on the date above, at the commit that carries this plan.
**References rot — re-verify before handover.**

### What this plan uses

| `path:line` | What it is | How this plan uses it |
| --- | --- | --- |
| `packages/jinn/src/shared/engine-limits-claude.ts:232` | `collectClaudeLimits` — the account's real windows: OAuth usage API (`:72`) with the CLI statusline snapshot as fallback, `stale` after 30 min (`:161`) | **The reading.** Called directly by the loop; the ticket's "expose as a callable" was already true. |
| `packages/jinn/src/shared/engine-limits-claude-usage.ts:17` | `"session"` → `5h`, `"weekly_all"` → `7d`, scoped buckets → `7d <model>` | The window names the verdict keys on; every `7d*` bucket is held to the weekly ceiling. |
| `packages/jinn/src/shared/engine-limits.ts:320` | `collectEngineLimits` — per-engine dispatch; `UNSUPPORTED_REASONS` at `:301` | OpenCode's not-applicable reason lands in the table (FR-015). |
| `packages/jinn/src/cli/limits.ts:78` | `jinn limits [--json] [--engine]` | Already a script-callable reading; nothing added. |
| `packages/jinn/src/gateway/api.ts:4499` | `GET /api/engine-limits` | Already an HTTP reading; nothing added. |
| `packages/jinn/src/gateway/background-refresh.ts:41` | 15-minute engine-health refresh, config read at fire time, unref'd | The pattern the loop follows (cadence read each fire, unref'd timer). |
| `packages/jinn/src/gateway/api.ts:2846` | `POST /api/work-items/:id/dispatch` — the Todo Dispatcher spawn recipe, previously inline | **Extracted** to `gateway/todo-dispatch.ts::startTodoDispatcher`; the route is the HTTP face. |
| `packages/jinn/src/gateway/todo-claim.ts:113` | `claimTodoForDispatch(res, id)` — the claim gate, HTTP-shaped | Split: `takeDispatchClaim` (`:91`) is the HTTP-free core the loop uses; the route wrapper stays. |
| `packages/jinn/src/gateway/todo-capture-api.ts:32` | *"The spawn deliberately follows the Todo Dispatcher route's recipe step for step … a second, subtly different spawn is how one of them rots"* | The reason the recipe was extracted rather than copied a third time. |
| `packages/jinn/src/gateway/system-employees.ts:15` | `todo-dispatcher` — the system employee that routes a Todo (`:30` delegates to the best-fit employee); `isSystemEmployeeName` at `:87` | The one LLM turn per start; told via a prompt suffix that the start is Claude allowance (FR-003). `isSystemEmployeeName` excludes its sessions from "operator-driven". |
| `packages/jinn/src/gateway/system-employee-spawn.ts:19` | `preflightSystemEmployee` — 409 on attachment, 502 on missing engine | Its status codes pass through the route unchanged. |
| `packages/jinn/src/work-items/dispatch-config.ts:253` | `resolveTodoDispatch`; `autoStart` at `:36`; `engine` override | `autoStart: false` and a non-Claude `engine` both skip a Todo (FR-011). |
| `packages/jinn/src/work-items/stop-cause.ts:77` | `isParked`, `readStopCause` at `:98` | Originally read to skip parked Todos (FR-011). That rule could never fire — a park is `blocked` plus `parkedUntil`, and leaving `blocked` deletes it, so no `backlog` Todo carries one — and removed it. Parked Todos are excluded by status; `work-items/park-expiry.ts` re-queues them when the date passes. |
| `packages/jinn/src/work-items/labels.ts:48` | `normalizeLabelName` — throws without a letter or digit | The config validator mirrors the rule so a bad `requireLabel` is refused at load. |
| `packages/jinn/src/work-items/frozen-schemas.ts:32` | `priority BETWEEN 0 AND 3`; `packages/web/src/lib/todos.ts:186` says 3 is High | Ordering: priority descending, then oldest. |
| `packages/jinn/src/gateway/api.ts:1096` | `sessionsHoldingEngineCapacity` — `waiting`, or transport `running`/`queued` | FR-007's definition of "holds engine capacity"; the busy guard. |
| `packages/jinn/src/sessions/registry.ts:1112` | `listSessions` with `lastActivity`, `parentSessionId`, `source`, `employee` | FR-006a: an operator-driven session's activity; and "was Jinn active since the last reading" for the usage-delta signal (FR-006c). |
| `packages/jinn/src/shared/claude-settings.ts:43` | `buildStatusLineRecorderCommand` — writes `<session>.json` into the limits dir on every statusline call | FR-006b: the newest file's mtime is the operator's last Jinn interactive turn. |
| `packages/jinn/src/engines/claude-interactive.ts:1259` | The only caller that sets `statusLineDir: CLAUDE_LIMITS_DIR` (`paths.ts:79`) | Confirms signal (b) covers exactly Jinn's interactive PTY sessions; `remote-stage.ts:1250` deliberately does not install it remotely. |
| `packages/jinn/src/shared/models.ts:151` | `engineAvailable` — bin-on-PATH check | The "Claude is installed" guard (not an auth check; an unauthenticated CLI yields a non-live reading, which holds). |
| `packages/jinn/src/shared/engine-health.ts:75` | `isEngineExhausted`; `recordExhaustedWindows` at `:179` written by the collector | Hold before reading when Claude is already recorded as out. |
| `packages/jinn/src/shared/config.ts:70` / `config-types.ts:56` | `gateway.todoRecovery` — the precedent for a gateway-level feature block with a validator | `gateway.idleCapacity` follows it. |
| `packages/jinn/src/gateway/server.ts:785` | `startBackgroundRefreshes(...)`; the loop starts at `:874`, after `apiContext` exists | Wiring and shutdown. |

### What was found and rejected

| `path:line` | What it is | Why not |
| --- | --- | --- |
| `packages/jinn/src/cron/scheduler.ts:24` / `runner.ts:42` | Cron: a prompt run by an engine on a schedule | An LLM would spend Claude capacity — on the very window being measured — to make a handful of numeric comparisons, and would be non-deterministic about it. The ticket's word "cron" is satisfied by a timer, not by a prompt. |
| `packages/jinn/src/workflows/trigger-service.ts` | Workflow triggers (events/polls) | Same objection: nodes are LLM sessions; no numeric-threshold trigger exists. |
| A new MCP tool (`get_engine_limits`) | Rung 5 of the Footprint Ladder | Only needed if an LLM made the decision; it does not. Manifest budget untouched. |
| `~/.claude/projects/**` transcript mtimes on the gateway host | A fourth "operator live" signal | The operator's Claude Code runs on other machines; the gateway would never see it. Speculative (§3). The usage-delta signal covers every machine. |
| `excludeLabels` as a config list (first draft) | A configurable opt-out list | One consumer, the default `no-auto-start`. Now a constant (`IDLE_CAPACITY_OPT_OUT_LABEL`). |
| Stop-on-ceiling (interrupt a running session) | Consumption bound | A larger design; recorded as Open Decision 1 in the spec, not built. |

### The finding that shapes the plan

**Every primitive already exists; the decision does not.** The reading (with reset times), the
Dispatcher, the claim gate, the opt-out flag, the park state and the busy-session count were all
in the tree. The feature is one pure decision (`shared/idle-capacity.ts`), one timer that
applies it (`gateway/idle-capacity.ts`), and one extraction so the timer and the button share a
spawn. The one thing the tree could not tell us — whether the operator is live on a machine
Jinn cannot see — is answered by the reading itself: usage that rose while Jinn was quiet;
the common case, the operator mid-chat with an employee, is a top-level session's `lastActivity`.

### Numbers, with their source

`size-baseline.json:3` `"limit": 300`; `pnpm ratchet --check` on this branch:

| File | Lines | Budget | Note |
| --- | --- | --- | --- |
| `packages/jinn/src/gateway/api.ts` | 5126 | 5114 | already over on `origin/main` (5191); **this branch shrinks it by 65** |
| `packages/jinn/src/shared/engine-limits.ts` | 367 | 373 | under |
| `packages/jinn/src/gateway/server.ts` | 1339 | 1305 | already over on `origin/main` (1334); +5 here for wiring |
| every new file | ≤ 300 | 300 | under (`gateway/idle-capacity.ts` is the largest) |

The remaining ratchet violations on this branch are the ones `origin/main` already carries.

## Summary

A gateway timer reads `collectClaudeLimits()` every `intervalMinutes`, chooses a tier
(interactive / overnight / daytime) from the operator's presence and the clock, applies that
tier's ceilings and lookaheads to the five-hour and weekly windows, and — when a window is about
to lapse with capacity to spare, capacity is idle, and the window's start cap is not reached —
starts the best eligible backlog Todo through the built-in Todo Dispatcher, leaving a system
comment saying why. `GET /api/idle-capacity` previews the next tick.

**Constraints**: 300-line file limit with a shrink-only ratchet; no MCP tool; four CI gates
(`pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`); lint floor of complexity 10 / 50
lines per function on every new file.

**Scale/Scope**: ~6 new modules, 1 route, 1 config block, 1 extraction, 4 test files.

## Technical Context

**Language/Version**: TypeScript on Node 24 (repo `engines`), ESM
**Primary Dependencies**: none added; `Intl.DateTimeFormat` for the zone
**Storage**: none added — the per-window ledger and operator sighting are in-memory by design
(a restart errs towards one extra start, which the live ceiling check then gates)
**Testing**: Vitest, real SQLite store in a throwaway `JINN_HOME`, injected collector/clock/
dispatch/operator signals
**Target Platform**: the gateway process
**Performance Goals**: one collector call per tick (an HTTPS GET + a `claude auth status`
spawn); negligible
**Constraints**: no LLM in the decision; off by default

## Constitution Check

| Principle | Verdict | Evidence |
| --- | --- | --- |
| **I — never upstream** | PASS | Fork-local by construction. |
| **II — direction, with rung stated** | PASS, **rung 1** | Work starts on spare capacity without a human. Rung 4 (the preview) is built underneath it so the decision is auditable. |
| **III — verify the premise** | PASS | The ticket's item 1 premise ("expose the collector") was checked and found already true at three call sites (table above); the ticket's "cron" premise was examined and replaced with a timer, with the reason recorded. |
| **IV — Footprint Ladder** | PASS, **rung 1/2** | Extends config, adds a GET route and a gateway loop. No MCP tool. |
| **V — no speculative infrastructure** | PASS with one flag | Every config key has the operator as its named consumer (a comment on the originating Todo asks for thresholds and time windows to be configurable) and a test that exercises it. The first draft's `excludeLabels` list was removed as speculative. |
| **VI — tests that can fail for a reason** | PASS | Ceilings, lookaheads, past resets, missing windows, tier selection, zone/wrap, operator signals, ledger identity, per-tier caps, config refusal: each is a red test if its guard is removed. No constant restatements remain. |
| **VII — plan opens with a `file:line` table** | PASS | Above, with rejections and sourced numbers. |
| **VIII — comments explain why and stay true** | PASS (obligation) | The first draft's "never runs a window near the top" claims were false and are gone; the docstring, the doc and the spec now say a ceiling gates *starting*. |
| **Hard constraint — public repo** | PASS | No names, keys or home paths; `Europe/London` is a zone, not a person. |

**Complexity Tracking**: none. No principle is violated in a way that needs justifying.

## Project Structure

### Documentation (this feature)

```
specs/002-idle-capacity-auto-start/
├── spec.md
├── plan.md
├── research.md
└── tasks.md
docs/idle-capacity.md          # operator-facing
```

### Source Code (repository root)

```
packages/jinn/src/
├── shared/
│   ├── idle-capacity-config.ts        # policy shape, defaults, resolve, validator
│   ├── idle-capacity.ts               # tier selection, quiet hours, verdict (pure)
│   ├── config-types.ts                # gateway.idleCapacity (+6 lines)
│   ├── config.ts                      # validator wired (+2 lines)
│   └── engine-limits.ts               # UNSUPPORTED_REASONS incl. opencode (−6 lines net)
├── gateway/
│   ├── idle-capacity.ts               # the timer: guards → tier → verdict → start → comment; preview
│   ├── idle-capacity-backlog.ts       # eligibility and order
│   ├── idle-capacity-operator.ts      # "the operator is live": three signals
│   ├── todo-dispatch.ts               # startTodoDispatcher (extracted from api.ts)
│   ├── todo-claim.ts                  # takeDispatchClaim (HTTP-free core)
│   ├── api.ts                         # thin dispatch route; GET /api/idle-capacity
│   └── server.ts                      # start/stop wiring
└── __tests__ (sibling dirs)
    ├── shared/__tests__/idle-capacity.test.ts
    ├── gateway/__tests__/idle-capacity-harness.ts
    ├── gateway/__tests__/idle-capacity-loop.test.ts
    ├── gateway/__tests__/idle-capacity-tiers.test.ts
    └── gateway/__tests__/idle-capacity-route.test.ts
```

## Execution Order

1. Extract the Dispatcher spawn (`todo-dispatch.ts`, `takeDispatchClaim`) — existing route tests
   prove the extraction is faithful before anything new uses it.
2. Pure policy + verdict, with tests.
3. Backlog eligibility, operator detection, the loop, with tests against the real store.
4. Config block + validator; server wiring; preview route; route test through the real spawn.
5. Docs, spec artefacts, OpenCode reason.

## Post-Design Constitution Re-check

Re-run after review rounds 1 and 2 (senior-developer-qa): round 2 added the operator-driven-session signal and made the preview read the detector without advancing it; the flat policy was replaced by tiers, the
false safety claims were corrected, the past-reset and missing-weekly holes were closed, the
ledger keys on the window's reset alone, the preview reports the window count on every path,
the route's status pass-through was restored, and the ratchet delta of this branch is zero
new violations. The table above was re-verified afterwards.
