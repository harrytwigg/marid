# Quickstart: Validating the Todo Session Tree

**Feature**: `specs/001-todo-session-tree/` | **Date**: 2026-09-18

How to prove the feature works. Details live in [`contracts/work-item-sessions-tree.md`](contracts/work-item-sessions-tree.md)
and [`data-model.md`](data-model.md); this file is the run guide.

## Prerequisites

- Node ≥ 24 < 25, pnpm 10.6.4 (`package.json` `engines`).
- A built tree: `pnpm build`.
- A running instance for the manual pass: `pnpm start`.

## The four gates

Each is a required CI job (constitution, *Hard Constraints*):

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

## The size ratchet — read this before committing

```bash
node scripts/ratchet.mjs
```

**This is red on the branch before you start** — 24 pre-existing violations, including
`packages/jinn/src/gateway/api.ts` (5186 lines against a 5114 baseline). Do not read a red
ratchet as permission. Compare the violation list before and after your change: the files this
feature touches must not appear as *new* entries, and these three have no room at all —

| File | Headroom |
| --- | --- |
| `packages/web/src/routes/todos/task-page/task-page.tsx` | **0 lines** (586 / 586) |
| `packages/web/src/routes/todos/task-page/activity.tsx` | **0 lines** (556 / 556) |
| `packages/web/src/routes/todos/task-page/props-rail.tsx` | **3 lines** (297 / 300 limit) |
| `packages/web/src/routes/todos/__tests__/task-page.test.tsx` | **0 lines** (582 / 582) |

New behaviour goes in new modules; new tests go in new `__tests__` files.

## Targeted suites

```bash
pnpm --filter @jinn/web test
pnpm --filter jinn test
```

## Manual validation — build a real tree

With an instance running:

1. **Create a Todo and dispatch it.** Open the Todo, click **Dispatch**. The rail shows
   "Dispatcher working".
2. **US1 — switch into it.** Click the session reference. You land in that session's chat.
   *Then check the regression that motivated the feature*: the Details rail must show the
   creator as a named, clickable reference — **no `session:<uuid>` text anywhere on the page**
   (SC-002).
3. **US2 — fan out.** From the dispatcher session, delegate to two employees (`delegate_task`,
   `packages/jinn/src/mcp/delegation-tools.ts:95`). Return to the Todo **without reloading**:
   both children must have appeared beneath their parent, each naming its employee, its state,
   and the Todo it minted (FR-009, SC-006).
4. **Depth.** From one child, delegate again. The grandchild appears under *its* parent, not
   flattened to the root.
5. **US3 — review.** Move the Todo to `in_review`, then delegate onto it. Per
   `resolveDelegationLinkRole` (`packages/jinn/src/work-items/link-role.ts:51`) the link role is
   inferred as `review`; the new node must be visibly distinguishable from the execution
   attempts (FR-006, SC-004).
6. **Finished work stays.** Let a child session finish. Its node remains and stays clickable
   (FR-010, SC-007).
7. **Empty case.** Open a Todo that was never dispatched: the page looks exactly as it does
   today, with no empty tree region (FR-012).

## What automated tests must cover

Derived from the contract's C1–C10. Per Principle VI these are branching logic and boundary
conditions, not glue:

| Area | Cases |
| --- | --- |
| Tree building (unit) | cycle terminates (C4); a session reachable by two paths appears once; depth bound truncates and marks (C6); count bound (C6); role defaults to `execute` on NULL (C5); an archived session stays in the tree |
| Route (integration) | `?tree=1` shape; **un-parameterised response unchanged** (C1); empty Todo (C10); no write performed (C9) |
| Directory | resolves a `createdBy` session that is *not* linked to the Todo (C8) — the reported bug |
| Web | node renders employee/state/Todo; activation navigates to `/?session=<id>`; review node distinguishable; truncation marker shown |

**Do not write**: a test asserting the node list equals a hand-copied fixture the builder already
derives, or a snapshot of the rendered tree. Both fail the constitution's question — *if this
fails, have I learned something is broken, or only that something is different?*

## Expected outcome

All four gates green; the ratchet no worse than before; the seven manual steps pass; a Todo is no
longer a dead end.
