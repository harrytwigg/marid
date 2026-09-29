# Implementation Plan: Todo Session Tree

**Branch**: `claude/jin-session-switching-tree-6f15aa` | **Date**: 2026-09-18 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/001-todo-session-tree/spec.md`

## Existing Infrastructure *(Principle VII — opens the plan)*

Verified against the worktree on the date above. **References rot — re-verify before handover.**

### What this plan uses

| `path:line` | What it is | How this plan uses it |
| --- | --- | --- |
| `packages/jinn/src/gateway/api.ts:2828` | `GET /api/work-items/:id/sessions` | Extended with `?tree=1`. No new route. |
| `packages/jinn/src/gateway/api.ts:1159` | `serializeSessionList` — calls `listSessions()`, a **full session-table read, on every call** | The tree is an extra in-memory pass over an array this handler already builds. This is why R1 chose the server. |
| `packages/jinn/src/gateway/api.ts:1128` | `serializeSession` returns `{ ...session }` | `parentSessionId` / `workItemRole` already reach the browser; nothing new goes on the wire. |
| `packages/jinn/src/sessions/registry.ts:1422` | `listSessionsByWorkItem` | The tree roots. |
| `packages/jinn/src/sessions/registry.ts:145` | `parentSessionId` off `parent_session_id` | The tree edge. |
| `packages/jinn/src/sessions/registry.ts:136` | `workItemRole` off `work_item_role` | FR-006 — review is **already in the database**. |
| `packages/jinn/src/work-items/link-role.ts:51` | `resolveDelegationLinkRole` | Where the review role is decided; nothing to add. |
| `packages/jinn/src/work-items/link-role.ts:22` | `toWorkItemLinkRole` — NULL means `execute` | The node's `role` default. |
| `packages/jinn/src/sessions/delegated-activity.ts:13` | `buildDelegatedActivityIndex` — *"graph cycles are contained"* | The cycle rule the tree walk reuses rather than re-inventing (FR-007). |
| `packages/jinn/src/sessions/migrate.ts:87` | `idx_sessions_parent` | Makes the parent edge an indexed read if a query is ever preferred to the in-memory pass. |
| `packages/web/src/hooks/use-query-invalidation.ts:112` | `['work-item-sessions']` **prefix** invalidation, pushed by `session:started`/`created` (:174), `updated` (:181), `deleted` (:191) | **FR-009 costs no code** — a key under that prefix inherits live updates. |
| `packages/web/src/routes/todos/task-page/task-page.tsx:477` | `navigate('/?session=<id>')` | The navigation every node reuses (FR-002). |
| `packages/web/src/routes/todos/task-page/props-rail.tsx:196` | `rail-dispatch-session` | The affordance the tree sits beside; its behaviour is the model. |

### What was found and rejected

| `path:line` | What it is | Why not |
| --- | --- | --- |
| `packages/web/src/lib/api.ts:796` | `getSessionChildren` — plumbed to the browser, **zero callers in `packages/web/src`** | Walking the tree with it is one round trip per node, unbounded in depth (R1). It stays uncalled. |
| `packages/jinn/src/gateway/api.ts:2216` | `GET /api/sessions/:id/children` | Same reason — it is the per-node route; the tree is assembled server-side in one pass instead. |
| `packages/web/src/components/peek/peek-stack.tsx` | stacked peek surface | The ask is to *switch* to the session; the rail already navigates (R10). |
| `packages/jinn/src/mcp/delegation-tools.ts:26` | *"`jinn_request_review` is deliberately ABSENT"* | Confirms review arrives on the delegation edge — there is no second edge to traverse (R9). |

### The finding that shapes the plan

**The join does not exist and both halves are built.** `getSessionChildren` has been sitting in
the web client with no caller; `workItemRole` has been on the wire, unnamed, since the link-role
work. This feature adds one traversal and one component — it adds no schema, no tool, no channel.

### Numbers, with their source

Read from `size-baseline.json` (`"limit": 300`) and `node scripts/ratchet.mjs` on this branch:

| File | Lines | Budget | Headroom |
| --- | --- | --- | --- |
| `packages/jinn/src/gateway/api.ts` | 5186 | 5114 | **−72 (already over)** |
| `packages/web/src/routes/todos/task-page/task-page.tsx` | 586 | 586 | **0** |
| `packages/web/src/routes/todos/task-page/activity.tsx` | 556 | 556 | **0** |
| `packages/web/src/routes/todos/task-page/props-rail.tsx` | 297 | 300 (limit) | **3** |
| `packages/web/src/routes/todos/__tests__/task-page.test.tsx` | — | 582 | **0** |

`pnpm ratchet` reports **24 pre-existing violations** on this branch. That is not cover for
adding the 25th — the delta for this feature's files must be zero.

## Summary

A Todo is a dead end: its creator session prints as raw text and only a live `todo-dispatcher`
is clickable. This plan makes every session a Todo references clickable, and renders the tree of
sessions the Todo caused — children by delegation, reviewers included — as one read surface.

The approach is deliberately small because the substrate is already there: extend the route the
page already calls with an opt-in `?tree=1` shape, assemble the tree server-side in a new module
(the gateway file is over budget), name four fields that already arrive on the wire, and render a
tree component whose query key inherits the existing live-invalidation prefix.

## Technical Context

**Language/Version**: TypeScript on Node ≥ 24 < 25 (`package.json` `engines`), React 19

**Primary Dependencies**: gateway — `better-sqlite3`; web — React 19, `@tanstack/react-query` v5, `react-router-dom` v7, Tailwind via CSS variables, `lucide-react`

**Storage**: SQLite (`sessions`, `work_items`). **No migration** — every field exists.

**Testing**: Vitest per package (`pnpm --filter @jinn/web test`, `pnpm --filter jinn test`), Playwright for e2e

**Target Platform**: local gateway + browser UI

**Project Type**: pnpm/turbo monorepo — gateway (`packages/jinn`) + web (`packages/web`)

**Performance Goals**: a 50-node tree renders and expands without a perceived stall (SC-005); one HTTP request per Todo page load, not one per node

**Constraints**: 300-line file limit with a shrink-only ratchet (see the numbers above); manifest token budget untouched (no MCP tool added); four CI gates — `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`

**Scale/Scope**: bounds of depth 6 / 200 nodes (R4); ~2 new modules, ~1 route branch, 4 named wire fields

## Constitution Check

*GATE: passed before Phase 0; re-evaluated after Phase 1 below.*

| Principle | Verdict | Evidence |
| --- | --- | --- |
| **I — never upstream** | PASS | Nothing here reasons about upstream. Fork-local spec artifacts are first-class. |
| **II — direction, with rung stated** | PASS, **rung 4, and it stops there** | The spec's *Why This Matters* says so plainly. The justification is Principle II's own text: *"A decision the operator cannot audit after the fact is not delegation, it is a black box."* This builds the audit surface autonomy presupposes; it moves no decision from operator to system and does not pretend to. |
| **III — verify the premise** | PASS | The premise was verified, not assumed: `props-rail.tsx:135` renders `createdBy` through a fallback-to-key helper — that *is* the `session:<uuid>` text. Every claim in the tables above was read from the tree. |
| **IV — Footprint Ladder from the bottom** | PASS, **rung 1** | Extends an existing route with a query param; adds no CLI command, no MCP tool, no out-of-process server. The manifest budget is untouched — **no core tool is added**, so `tool-manifest-budget.test.ts` is not in play. |
| **V — no speculative infrastructure** | PASS | No config key, no hook, no extension point. The bounds in R4 are constants, not settings, precisely because nothing would set them. The `?tree=1` param has one named consumer: the Todo page. |
| **VI — tests that can fail for a reason** | PASS | Cases are cycles, bounds, unresolvable references, and role defaulting — branching logic and boundaries. `quickstart.md` explicitly bans a snapshot of the tree and a hand-copied node fixture. A regression test pins that the un-parameterised response is unchanged; that can fail for a real reason (a broken existing caller). |
| **VII — plan opens with a `file:line` table** | PASS | Above, with rejections included and numbers sourced. |
| **VIII — comments explain why and stay true** | PASS (obligation) | Two comments become false if written carelessly: `packages/jinn/src/sessions/registry.ts:1418`'s "execution attempts" doc comment and `delegation-tools.ts:26`'s review note both remain true under this plan — verify at implementation time that nothing here falsifies them. |
| **Hard constraint — public repo** | PASS | No names, keys, or absolute home paths. Example ids in the contract are synthetic. |

**No Complexity Tracking entries.** No violation requires justification.

## Project Structure

### Documentation (this feature)

```text
specs/001-todo-session-tree/
├── plan.md                                  # This file
├── spec.md
├── research.md                              # Phase 0 — R1..R10
├── data-model.md                            # Phase 1
├── quickstart.md                            # Phase 1
├── contracts/
│   └── work-item-sessions-tree.md           # Phase 1
├── checklists/
│   └── requirements.md
└── tasks.md                                 # /speckit-tasks — NOT created here
```

### Source Code (repository root)

```text
packages/jinn/src/
├── sessions/
│   ├── session-tree.ts                      # NEW — traversal, bounds, node + directory shaping (≤300 lines)
│   ├── registry.ts                          # unchanged (already over budget)
│   └── delegated-activity.ts                # unchanged — its cycle rule is reused, not copied
├── gateway/
│   └── api.ts                               # ~2-line `?tree=1` branch ONLY; file is already over budget
└── sessions/__tests__/
    └── session-tree.test.ts                 # NEW — cycles, bounds, missing refs, role default

packages/web/src/
├── routes/todos/task-page/
│   ├── session-tree.tsx                     # NEW — the tree component (≤300 lines)
│   ├── session-ref.tsx                      # NEW — the clickable session reference used by rail/whisper/activity
│   ├── props-rail.tsx                       # net-neutral edit: raw text → <SessionRef>. 3 lines of headroom.
│   ├── task-page.tsx                        # net-neutral edit: mount the tree. 0 lines of headroom.
│   ├── activity.tsx                         # net-neutral edit: actor → <SessionRef>. 0 lines of headroom.
│   └── whisper.tsx                          # 107 lines — has room
├── lib/api.ts                               # name 4 existing wire fields + the tree fetcher
└── routes/todos/__tests__/
    └── session-tree.test.tsx                # NEW — do not grow task-page.test.tsx (0 headroom)
```

**Structure Decision**: the monorepo's existing split. Traversal lives in `packages/jinn/src/sessions/`
beside the `parentSessionId` mapping and the cycle rule it reuses — not in `gateway/`, which is a
transport layer and whose file is over budget. UI lives in the Todo page's own directory beside
`props-rail.tsx`. **Every file marked "net-neutral" must not grow**; where an edit would add
lines, extract the surrounding block into the new module instead.

## Execution Order

Sliced so each user story is independently shippable (spec priorities):

1. **Foundation** — `session-tree.ts` + its unit tests (cycles, bounds, missing refs, role default). No UI.
2. **US1 (P1)** — `?tree=1` branch, `directory`, `session-ref.tsx`; swap the raw `createdBy` text. *Ships the reported bug fix on its own.*
3. **US2 (P2)** — `session-tree.tsx`, mounted on the Todo page, live via the inherited query-key prefix.
4. **US3 (P3)** — name `workItemRole` on the wire; render the review distinction.
5. **Hardening** — truncation marker, archived rendering, the C1 un-parameterised regression test, ratchet delta check.

## Post-Design Constitution Re-check

Re-evaluated against the Phase 1 artifacts:

- **Rung 1 holds.** The design added no route, no tool, no channel, no column. The only new
  surface is one query parameter with one named consumer.
- **Principle V holds under pressure.** The `directory` field (R8) was the one place a general
  "session lookup service" could have been invented. It is not one: it is a map scoped to the ids
  a single Todo references, built from an array the handler already holds.
- **Principle VI holds.** Every test named in `quickstart.md` fails for a reason; the two shapes
  that would not — a tree snapshot and a hand-copied node fixture — are banned there by name.
- **One risk to carry into tasks.** The 300-line ceilings are the tightest real constraint. Three
  of the five files to edit have 0–3 lines of headroom, and `api.ts` is already over. Any task
  that adds lines to those files must extract instead. This belongs in `tasks.md` as an
  acceptance condition, not as a note.

**Gate: PASS.** No Complexity Tracking entries required.
