# Tasks: Todo Session Tree

**Input**: Design documents from `specs/001-todo-session-tree/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: INCLUDED. Not optional here — constitution Principle VI requires tests for branching
logic, parsing, state transitions and boundary conditions, and this feature is mostly boundary
conditions (cycles, depth, count, unresolvable references, role defaulting).

**Organization**: grouped by user story, in the spec's priority order, so each ships alone.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable — different files, no dependency on an incomplete task
- **[Story]**: US1 / US2 / US3 from spec.md

## Path Conventions

pnpm/turbo monorepo: gateway in `packages/jinn/src/`, web in `packages/web/src/`, tests in
sibling `__tests__/` directories (per plan.md *Project Structure*).

---

## ⚠️ Size Ratchet — an acceptance condition on every task below

`node scripts/ratchet.mjs` is **already red on this branch (24 violations)**. That is not cover
for adding the 25th. Before any task is considered done, its files must not be new violations.

| File | Headroom | Rule for this feature |
| --- | --- | --- |
| `packages/jinn/src/gateway/api.ts` | **−72, already over** | ≤ 3 net new lines; everything else in a new module |
| `packages/web/src/routes/todos/task-page/task-page.tsx` | **0** | net-neutral or extracting only |
| `packages/web/src/routes/todos/task-page/activity.tsx` | **0** | net-neutral or extracting only |
| `packages/web/src/routes/todos/task-page/props-rail.tsx` | **3** | ≤ 3 net new lines |
| `packages/web/src/routes/todos/__tests__/task-page.test.tsx` | **0** | **do not touch** — new tests go in new files |

Every new file must be ≤ 300 lines (`size-baseline.json` `"limit": 300`). Nothing may be added
to `size-baseline.json` by hand.

---

## Phase 1: Setup

**Purpose**: establish the baseline this change is measured against.

- [X] T001 Record the pre-change ratchet baseline by running `node scripts/ratchet.mjs` and saving the violation list to compare against at the end; confirm `packages/jinn/src/gateway/api.ts` is the only feature-touched file already in violation
- [X] T002 [P] Re-verify every `path:line` reference in `specs/001-todo-session-tree/plan.md` and `research.md` against the current tree (Principle VII — references rot), correcting any that have moved

---

## Phase 2: Foundational (blocking prerequisites)

**Purpose**: the traversal every user story reads from. **No user story work begins until this
phase is complete.**

- [X] T003 Create `packages/jinn/src/sessions/session-tree.ts` exporting a pure `buildSessionTree(sessions, todoId, opts)` that takes an already-loaded session array (never queries), groups by `parentSessionId`, and returns the `SessionTreeResponse` shape in `specs/001-todo-session-tree/data-model.md`
- [X] T004 In `packages/jinn/src/sessions/session-tree.ts`, implement breadth-first traversal with a `visited` set following the containment rule stated at `packages/jinn/src/sessions/delegated-activity.ts:13` ("graph cycles are contained"), so no session is its own descendant and no id appears twice (FR-007, contract C4)
- [X] T005 In `packages/jinn/src/sessions/session-tree.ts`, implement the depth ≤ 6 and node ≤ 200 bounds, setting per-node `truncated: { reason }` and the response-level `truncated` flags — never a silent `slice()` (FR-008, contract C6)
- [X] T006 ~~Implement tombstone nodes for a referenced parent id absent from the session array~~ — **withdrawn on evidence.** A session linked to a work item cannot be hard-deleted (`registry.ts:1730`/`:1750`, `api.ts:2188`), so no tree node can name a missing row; for the one deletable case (an untracked spawn) the `parentSessionId` edge dies with the row, so a placeholder root would graft unrelated sessions onto every Todo's tree. Replaced by: `directory` reports a **directly named** id that no longer resolves as `missing: true`, and the UI renders it as text rather than a dead link (FR-010 as revised, research R6)
- [X] T007 In `packages/jinn/src/sessions/session-tree.ts`, derive each node's `role` via `toWorkItemLinkRole` from `packages/jinn/src/work-items/link-role.ts:22` so a NULL column reads as `execute` — import it, do not re-implement the default (FR-006, contract C5)
- [X] T008 In `packages/jinn/src/sessions/session-tree.ts`, build the `directory` map from session ids plus the Todo's `createdBy` and any `session:`-prefixed comment authors and audit actors passed in by the caller (FR-001, contract C8, research R8)
- [X] T009 Create `packages/jinn/src/sessions/__tests__/session-tree.test.ts` covering: a cyclic parent link terminates; a session reachable by two paths appears once; depth bound truncates and marks; count bound truncates and marks; NULL `work_item_role` reads as `execute`; an archived session stays in the tree; a named-but-absent id is reported missing
- [X] T010 Verify `packages/jinn/src/sessions/session-tree.ts` and its test file are each ≤ 300 lines and `node scripts/ratchet.mjs` shows no new violation versus the T001 baseline

**Checkpoint**: the traversal is correct and tested with no UI and no route.

---

## Phase 3: User Story 1 — Click into the session working this Todo (P1) 🎯 MVP

**Goal**: every session a Todo references is named and clickable; the reported `session:<uuid>`
dead end is gone.

**Independent test**: open a Todo worked by a non-dispatcher employee, click the session
reference, land in that session's chat. No tree required.

- [X] T011 [US1] Add the `?tree=1` branch to the `GET /api/work-items/:id/sessions` handler at `packages/jinn/src/gateway/api.ts:2828`, delegating to `buildSessionTree` — **≤ 3 net new lines** in this file, which is already over its baseline
- [X] T012 [US1] Collect the Todo's `createdBy` and its `session:`-prefixed comment authors and audit actors at the call site and pass them to `buildSessionTree` for the `directory` (contract C8)
- [X] T013 [P] [US1] Name `parentSessionId`, `workItemId`, `workItemRole` and `archivedAt` on `LinkedSessionWire` at `packages/web/src/lib/api.ts:677`, and add the tree response type and its fetcher — these fields already arrive via the `{ ...session }` spread at `packages/jinn/src/gateway/api.ts:1128`, so this names them rather than adding payload
- [X] T014 [P] [US1] Create `packages/web/src/routes/todos/task-page/session-ref.tsx` — a clickable reference resolving an id through the `directory` to employee + state, navigating with `navigate('/?session=' + encodeURIComponent(id))` exactly as `packages/web/src/routes/todos/task-page/task-page.tsx:477` does, and falling back to a shortened id when unresolvable
- [X] T015 [US1] Replace the raw `createdBy` text at `packages/web/src/routes/todos/task-page/props-rail.tsx:135` with `<SessionRef>` when the value is `session:`-prefixed, leaving the "You" and employee cases unchanged — **≤ 3 net new lines** in this file
- [X] T016 [US1] Replace the anonymous `"A session"` actor at `packages/web/src/routes/todos/task-page/whisper.tsx:87` with `<SessionRef>` (this file has room at 107 lines)
- [X] T017 [US1] Replace the `session:`-prefixed comment author branch at `packages/web/src/routes/todos/task-page/activity.tsx:39` with `<SessionRef>` — **net-neutral only**, this file is at its 556-line ceiling
- [X] T018 [US1] Widen the rail's clickable session beyond the live-`todo-dispatcher` narrowing at `packages/web/src/routes/todos/task-page/task-page.tsx:148` so any linked session — any employee, live or finished — is reachable; **net-neutral only**, this file is at its 586-line ceiling, so extract if it would grow
- [X] T019 [P] [US1] Add a gateway integration test asserting the **un-parameterised** `GET /api/work-items/:id/sessions` response is unchanged (contract C1) — the regression that would break `packages/web/src/components/talk/context/surface-adapters.ts:54` and the page's own `hasLiveSession` derivation
- [X] T020 [P] [US1] Add a test that `directory` resolves a `createdBy` session which is **not linked** to the Todo — the exact reported bug (contract C8)
- [X] T021 [P] [US1] Create `packages/web/src/routes/todos/__tests__/session-ref.test.tsx` covering: a resolvable id renders employee and state; activation navigates to `/?session=<id>`; an unresolvable id falls back without crashing. **Do not add to `task-page.test.tsx`** (0 headroom)

**Checkpoint**: SC-001 and SC-002 hold — one-click reach, zero raw `session:<uuid>` strings. **Shippable alone.**

---

## Phase 4: User Story 2 — See the whole tree (P2)

**Goal**: the delegation tree rooted at the Todo, every node clickable, updating live.

**Independent test**: delegate twice, nested; the Todo shows a three-level tree with correct
employees and states, and each node opens.

- [X] T022 [US2] Create `packages/web/src/routes/todos/task-page/session-tree.tsx` rendering `roots` recursively with indentation, each node showing employee, state, and — where present — the Todo it tracks (FR-004); ≤ 300 lines
- [X] T023 [US2] In `session-tree.tsx`, make each node activate to its session via `<SessionRef>`, and its `workItemId` activate to that Todo's page as a separate target (FR-005)
- [X] T024 [US2] Mount the tree on the Todo page with query key `["work-item-sessions", todoId, "tree"]` so it inherits the existing `['work-item-sessions']` prefix invalidation at `packages/web/src/hooks/use-query-invalidation.ts:112` — **FR-009 needs no new signalling**; keep `task-page.tsx` net-neutral
- [X] T025 [US2] Render the truncation marker when the response's `truncated` flags are set, naming what was withheld rather than showing a silently short tree (FR-008)
- [X] T026 [US2] Render archived nodes with a visible archived marker, and a directly named session that no longer resolves as plain text rather than a dead link (FR-010 as revised — see T006)
- [X] T027 [P] [US2] Create `packages/web/src/routes/todos/__tests__/session-tree.test.tsx` covering: nesting depth is preserved rather than flattened; a node activates to its session; a node's Todo activates separately; the truncation marker appears when flagged; an unresolvable reference renders without a link
- [X] T028 [P] [US2] Add a test that a Todo with no linked sessions renders no tree region and leaves the existing Dispatch affordance untouched (FR-012, contract C10)

**Checkpoint**: SC-003, SC-005, SC-006 hold.

---

## Phase 5: User Story 3 — Review hand-offs are distinguishable (P3)

**Goal**: a reviewer node reads as a review, not as more sub-work.

**Independent test**: delegate onto an `in_review` Todo; the node appears labelled as a review
and opens like any other.

- [X] T029 [US3] Render the node's `role` distinction in `packages/web/src/routes/todos/task-page/session-tree.tsx` so a review node is visually distinguishable from an execution attempt at a glance (FR-006, SC-004)
- [X] T030 [P] [US3] Add a test that a session linked with the review role renders as a review while an `execute`-linked sibling does not, and that a reviewer's own children still appear beneath it
- [X] T031 [P] [US3] Add a gateway test that a delegation onto an `in_review` Todo produces a node with `role: "review"`, exercising the inference already implemented at `packages/jinn/src/work-items/link-role.ts:51` — assert the tree surfaces it, do not re-test `resolveDelegationLinkRole` itself

**Checkpoint**: SC-004 holds. All three stories delivered.

---

## Phase 6: Polish & Cross-Cutting

- [X] T032 Confirm no comment, doc line, or error message was falsified by this change — specifically the "execution attempts" doc comment at `packages/jinn/src/sessions/registry.ts:1418` and the review note at `packages/jinn/src/mcp/delegation-tools.ts:26` (Principle VIII)
- [X] T033 Run `node scripts/ratchet.mjs` and diff against the T001 baseline; **the violation list must not have grown**, and no feature-touched file may be a new entry
- [X] T034 Run the four CI gates: `pnpm typecheck` ✅, `pnpm lint` ✅, `pnpm test` (gateway-events 8 ✅, jinn-cli 6443 ✅, web 3477 ✅; `@jinn/shell` fails on `spawnSync cargo ENOENT` — no Rust toolchain on this host, untouched by this change), `pnpm build` ✅
- [ ] T035 **NOT DONE — needs a live instance.** Walk the seven manual steps in [quickstart.md](quickstart.md), including the no-reload delegation check (SC-006). Blocked here: a real fan-out needs a booted gateway with engine credentials making actual `delegate_task` calls, which is not something to stand up unasked on the operator's machine. What stands in for it: the route suite drives the REAL `handleApiRequest` against a REAL SQLite registry with a real `linkSession(…, 'review')`, and the web suite asserts the rendering and the `navigate('/?session=…')` call. What remains genuinely unverified is the *live* path — SC-006's "appears without a reload", which rests on the `['work-item-sessions']` prefix invalidation being reached by a real `session:created` frame.
- [X] T036 Review the test suite against Principle VI: delete any assertion that only proves something is *different* rather than *broken*; confirm no snapshot test and no hand-copied node fixture was introduced

---

## Dependencies

```
Phase 1 (T001-T002)
  └─> Phase 2 Foundational (T003-T010)   ← BLOCKS everything below
        ├─> Phase 3 US1 (T011-T021)      ← MVP, shippable alone
        │     └─> Phase 4 US2 (T022-T028)   (needs SessionRef from T014)
        │           └─> Phase 5 US3 (T029-T031)  (needs the tree component from T022)
        └─> Phase 6 Polish (T032-T036)   ← after whichever stories ship
```

**Story independence**: US1 ships alone and fixes the reported bug. US2 depends on US1 only for
`SessionRef` (T014). US3 is a rendering change on US2's component.

## Parallel Opportunities

- **Phase 1**: T002 runs alongside T001.
- **Phase 2**: T004–T008 all edit `session-tree.ts` — **sequential**, despite being one module's worth of work.
- **Phase 3**: T013, T014 are parallel (different files); T019, T020, T021 are parallel once T011–T012 land.
- **Phase 4**: T027, T028 parallel after T022–T026.
- **Phase 5**: T030, T031 parallel after T029.

## Implementation Strategy

**MVP = Phase 1 + Phase 2 + Phase 3 (US1)** — 21 tasks. That alone kills the `session:<uuid>`
dead end that prompted the feature, and is worth shipping before the tree exists.

Then Phase 4 for the tree, Phase 5 for the review distinction, Phase 6 to close out. Each phase
ends at a checkpoint that maps to named success criteria, so stopping after any checkpoint
leaves a coherent product.
