# Phase 0 Research: Todo Session Tree

**Feature**: `specs/001-todo-session-tree/` | **Date**: 2026-09-18

All `path:line` references verified against the worktree on the date above.

---

## R1 — Where is the tree assembled: server or browser?

**Decision**: The gateway assembles the tree and returns it in **one** response.

**Rationale**: The browser has exactly one edge-walking primitive —
`getSessionChildren` (`packages/web/src/lib/api.ts:796`) — and walking a tree with it is one
HTTP round trip per node. A three-level fan-out of eight employees is nine requests before the
first node renders, and the depth is unknown in advance, so the request count is unbounded by
construction. That fails SC-005 (a 50-node tree stays interactive) on its own.

The decisive fact is that the server-side cost is **already being paid**:
`serializeSessionList` (`packages/jinn/src/gateway/api.ts:1159`) calls `listSessions()` — a full
session-table read — on *every* call to the route the Todo page already makes
(`packages/jinn/src/gateway/api.ts:2828`). Indexing that same array by `parentSessionId` and
walking it is in-memory work over data the request has already loaded. **The tree costs one
extra pass over an array the endpoint already builds.**

**Alternatives considered**:

- *Client-side walk using `getSessionChildren`* — rejected: unbounded round trips, and it would
  be the first caller of a function that has had none.
- *A recursive SQL CTE over `sessions`* — rejected: correct, but it re-reads rows the request
  already has in memory, and it puts the cycle rule in SQL where it cannot share the tested
  containment logic in R3.

---

## R2 — A new route, or an extension of the existing one?

**Decision**: Extend `GET /api/work-items/:id/sessions` with an opt-in `?tree=1` shape. No new
route.

**Rationale**: Two independent reasons, one of which is a hard CI constraint.

1. **The Footprint Ladder (Principle IV) prefers rung 1**, "extend something that exists". The
   Todo page already calls this exact route with this exact id; the tree is the same question
   asked with more of the answer.
2. **`packages/jinn/src/gateway/api.ts` is already over its size baseline.** `pnpm ratchet`
   reports 24 pre-existing violations on this branch, and `api.ts` is one of them — baseline
   5114 lines, tree 5186. Any new route block makes a red check redder. The `?tree=1` branch is
   a two-line addition inside a handler that already exists, and everything else lives in a new
   module (R7).

**Consequence for the plan**: the default (no `tree` param) response shape does not change, so
every existing caller — including `packages/web/src/components/talk/context/surface-adapters.ts:54`,
which reads the `["work-item-sessions", id]` cache — is untouched.

**Alternatives considered**:

- *`GET /api/work-items/:id/tree`* — rejected: a new route block in a file that is already over
  budget, for a question the existing route is already shaped to answer.
- *Widen the default response to always include the tree* — rejected: it would make every
  existing caller pay for a payload it does not read.

---

## R3 — Traversal and cycle containment

**Decision**: Breadth-first from the Todo's linked sessions, following `parentSessionId` edges
downward, carrying a `visited` set. Reuse the rule
`buildDelegatedActivityIndex` (`packages/jinn/src/sessions/delegated-activity.ts:13`) already
applies — its own comment states it: *"graph cycles are contained and an active session is never
counted as its own descendant."*

**Rationale**: There is already one tested answer to this question in the tree. A second,
differently-shaped answer would be two places for the same invariant to drift. BFS also makes
the truncation in R4 meaningful: when the bound bites, what survives is the shallow part of the
tree, which is the part the operator can act on.

**Alternatives considered**:

- *Depth-first* — rejected: truncation would keep one deep branch and drop the operator's
  siblings, which is the less useful half.
- *Trusting the data to be acyclic* — rejected: `parentSessionId` is a plain nullable column
  (`packages/jinn/src/sessions/registry.ts:145`) with no constraint preventing a cycle, and the
  existing code already defends against one.

---

## R4 — Bounds

**Decision**: Depth ≤ 6, total nodes ≤ 200. Exceeding either truncates and the response says so
explicitly, per branch.

**Rationale**: These are display bounds, not policy (spec Assumptions). Depth 6 covers
dispatcher → delegate → sub-delegate → reviewer with two levels of headroom; a tree deeper than
that is a runaway, and a runaway is itself the thing the operator needs to see, which the
truncation marker tells them. 200 nodes is comfortably above SC-005's 50-node interactivity
target, so the bound never fires in the case the success criteria measure.

FR-008 requires the operator be *told* what was withheld — so truncation is a field in the
payload, not a silent `slice()`.

**Alternatives considered**:

- *No bound* — rejected: violates FR-008 and puts an unbounded array in a response.
- *A configurable limit* — rejected under Principle V: no consumer exists that would set it.

---

## R5 — Live updates

**Decision**: Query key `["work-item-sessions", todoId, "tree"]`. No new signalling.

**Rationale**: `packages/web/src/hooks/use-query-invalidation.ts:112` invalidates on the
**prefix** `['work-item-sessions']`, and `session:started`, `session:created` (:174),
`session:updated` (:181) and `session:deleted` (:191) all push that key. A tree query whose key
begins with that prefix is invalidated by every event that can change the tree, including the
exact case FR-009 names — a delegation made while the page is open — because
`session:created`'s own comment at :172 already says *"A freshly created session (e.g. a
delegated child) joins the same list/linked-Todo caches as a started one."*

**FR-009 therefore requires no new code.** It requires choosing the key correctly.

**Alternatives considered**:

- *Polling* — rejected: the push path exists and already covers these events.
- *A new `work-item-tree` invalidation key* — rejected: a second key for the same events, and it
  would need its own case arm in the switch.

---

## R6 — Archived, deleted, and unresolvable sessions

**Decision**: Archived sessions are ordinary nodes carrying an archived marker. **There are no
tombstone nodes in the tree.** A session id the Todo names directly that no longer resolves is
reported in the `directory` as unresolvable.

> **Revised during implementation.** This entry originally called for a tombstone node holding
> the orphaned children of a deleted session. Writing it exposed the premise as false, in two
> steps. First, the case is nearly unreachable: `deleteSession` and `deleteSessions`
> (`packages/jinn/src/sessions/registry.ts:1730`, `:1750`) both carry
> `WHERE ... work_item_id IS NULL`, and the bulk route partitions linked sessions into
> `preserved` before deleting (`packages/jinn/src/gateway/api.ts:2188`) — a linked session is
> audit evidence and cannot be hard-deleted, which `shared/types.ts:379` states outright.
> Second, in the residue that *is* reachable — an untracked spawn — the tombstone would be
> actively wrong: when that row goes, its `parentSessionId` edge goes with it, so nothing
> connects its children to this Todo any more. A placeholder root would have grafted every
> globally-orphaned session onto *every* Todo's tree. The first draft of `session-tree.ts` did
> exactly that; it was removed rather than shipped.

**Rationale**: FR-010's real content survives — an archived session is the *most* likely subject
of an audit (SC-007 says reconstruction must not need database access), so hiding it defeats the
feature. The unresolvable case keeps its honest half in the `directory`, which is where the Todo
supplies the id itself and the lookup can therefore fail visibly.

**Alternatives considered**:

- *Filter archived out* — rejected: contradicts SC-007.
- *Tombstone roots for orphaned children* — rejected on the evidence above: it fabricates
  provenance, and the link it claims to preserve does not exist once the parent row is gone.
- *Re-root orphans at the Todo* — rejected for the same reason, more obviously.

## R7 — Module placement under the 300-line limit

**Decision**: A new module `packages/jinn/src/sessions/session-tree.ts` holds the traversal,
bounds, and node shaping. `api.ts` gains only the `?tree=1` branch. The web side gets a new
`packages/web/src/routes/todos/task-page/session-tree.tsx`.

**Rationale**: `size-baseline.json` sets a 300-line limit (`"limit": 300`) and its instructions
say a new file over the limit fails CI and nothing may be added to the baseline by hand. Three
of the files this feature touches are already at or near their ceilings:

| File | Lines now | Baseline |
| --- | --- | --- |
| `packages/jinn/src/gateway/api.ts` | 5186 | 5114 — **already over** |
| `packages/web/src/routes/todos/task-page/task-page.tsx` | 586 | 586 — **at ceiling** |
| `packages/web/src/routes/todos/task-page/props-rail.tsx` | 297 | no budget — **3 lines under the 300 limit** |
| `packages/web/src/routes/todos/task-page/activity.tsx` | 556 | 556 — **at ceiling** |
| `packages/web/src/routes/todos/__tests__/task-page.test.tsx` | — | 582 — at ceiling |

This is the plan's sharpest practical constraint and it is not optional: **`props-rail.tsx` has
three lines of headroom, and `task-page.tsx` and `activity.tsx` have none.** Every change to
those files must be net-neutral or extracting. New tests go in new `__tests__` files rather than
into `task-page.test.tsx`.

**Note for the implementer**: `pnpm ratchet` is red on this branch *before* any of this work —
24 pre-existing violations. "CI was already failing" is not cover for adding the 25th; check the
delta for the files this feature touches, not the total.

---

## R8 — Resolving a bare `session:<id>` to a name

**Decision**: The `?tree=1` response carries a `directory` — an id → identity map covering every
session the Todo *references*: tree nodes, the Todo's `createdBy`, and the session actors on its
comments and audit events. The web resolves references against it and falls back to a short id
when a reference is genuinely unresolvable.

**Rationale**: FR-001 covers three surfaces that each hold only an id today —
`props-rail.tsx:135` (`createdBy`), `whisper.tsx:87` (`"A session"`), and `activity.tsx:39`
(comment author). A session that *minted* this Todo need not be linked to it, so it can sit
outside the tree; without a directory the rail would still be stuck rendering a raw id.

The cost is nil for the same reason as R1: `listSessions()` is already read per request
(`api.ts:1160`), so an id → session lookup is a map build over an array the handler holds.

**Alternatives considered**:

- *One `GET /api/sessions/:id` per reference* — rejected: N round trips for text on first paint.
- *Resolve only what is in the tree* — rejected: leaves `createdBy` — the reported symptom —
  unfixed whenever the creator is not linked.

---

## R9 — Distinguishing review from execution

**Decision**: Surface the existing `workItemRole` on the node. No new model.

**Rationale**: `packages/jinn/src/sessions/registry.ts:136` already maps `work_item_role`, and
`resolveDelegationLinkRole` (`packages/jinn/src/work-items/link-role.ts:51`) already decides it
per delegation — explicitly, or by inferring `review` from an `in_review` Todo. The field even
already reaches the browser: `serializeSession` (`api.ts:1128`) spreads the whole session, and
`LinkedSessionWire` (`packages/web/src/lib/api.ts:677`) absorbs it into its index signature
without naming it.

FR-006 is therefore **a typing and rendering change**, not a schema change. The plan adds the
field to the wire type and draws it; it adds no column, no tool, and no delegation kind.
`delegation-tools.ts:26` is explicit that review deliberately has no separate tool — so there is
no second edge to traverse.

**Alternatives considered**:

- *A new `review` delegation kind* — rejected: Principle V, and the data already distinguishes it.

---

## R10 — Navigation target

**Decision**: Nodes navigate with `navigate('/?session=<id>')`, the call already used at
`packages/web/src/routes/todos/task-page/task-page.tsx:477`. A node's Todo reference navigates
to that Todo's page.

**Rationale**: Spec Assumptions fix this as a switch, not a preview, and the switch already has
one implementation on this page. Using a second mechanism for the same act would mean two
behaviours for the same gesture.

**Alternatives considered**:

- *The stacked peek surface* (`packages/web/src/components/peek/peek-stack.tsx`) — rejected in
  the spec: the ask is to switch to the session.

---

## Technical unknowns remaining

None. No NEEDS CLARIFICATION markers were carried in from the spec, and every decision above
resolved against code in the tree rather than against a preference.
