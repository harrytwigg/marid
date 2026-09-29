# Phase 1 Data Model: Todo Session Tree

**Feature**: `specs/001-todo-session-tree/` | **Date**: 2026-09-18

**No schema change.** Every field this feature needs already exists in the `sessions` table and
already reaches the browser. This document describes the *derived* shapes the tree endpoint
returns and where each field comes from.

---

## Source fields (existing, unchanged)

| Field | Origin | Used for |
| --- | --- | --- |
| `id` | `sessions.id` | Node identity, navigation target |
| `employee` | `sessions.employee` | Node identity (FR-004) |
| `status` | `sessions.status` | Node state (FR-004) |
| `title` | `sessions.title` | Node label |
| `parentSessionId` | `packages/jinn/src/sessions/registry.ts:145` | **The tree edge** (FR-003) |
| `workItemId` | `sessions.work_item_id` | The Todo a node tracks (FR-004, FR-005) |
| `workItemRole` | `packages/jinn/src/sessions/registry.ts:136` | Review vs execute (FR-006) |
| `archivedAt` | `sessions.archived_at` | Archived marker (FR-010) |
| `lastActivity` | `sessions.last_activity` | Sibling ordering |
| `workflowProvenance` | `sessions.workflow_provenance` | Phase sessions, per `isExecutionAttempt` (`packages/jinn/src/work-items/link-role.ts:36`) |

Indexes relied on: `idx_sessions_parent` (`packages/jinn/src/sessions/migrate.ts:87`) and
`idx_sessions_work_item` (named in the doc comment at
`packages/jinn/src/sessions/registry.ts:1418`).

---

## Derived entities

### `SessionTreeNode`

One session in its position beneath the Todo.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Session id |
| `employee` | string \| null | Recorded key; rendered even if the employee no longer exists in the org (Edge Cases) |
| `status` | string | As serialized today |
| `title` | string \| null | |
| `role` | `"execute"` \| `"review"` | From `workItemRole`, defaulting to `execute` — the meaning a NULL column already carries (`link-role.ts:22`) |
| `workItemId` | string \| null | The Todo this node tracks; `null` for an untracked spawn |
| `isRootLink` | boolean | True when linked directly to the Todo being viewed |
| `archived` | boolean | Derived from `archivedAt` |
| `children` | `SessionTreeNode[]` | Recursive; empty at a leaf or at the depth bound |
| `truncated` | `{ reason: "depth" \| "count" }` \| null | Set on the node whose children were withheld (FR-008) |

**Invariants**

- No `id` appears twice in one response — enforced by the `visited` set (R3).
- No node is its own ancestor.
- No node can name a session that is not in the table: a linked session cannot be hard-deleted (R6).
- `isRootLink` is true for at least one node whenever the Todo has any linked session.

### `SessionDirectoryEntry`

Identity for any session id the Todo *mentions*, whether or not it is in the tree (R8).

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | |
| `employee` | string \| null | |
| `status` | string | |
| `title` | string \| null | |
| `archived` | boolean | |
| `missing` | boolean | Referenced but no longer in the table |

Populated from: tree node ids, the Todo's `createdBy` when it is `session:<id>`, comment authors
with the `session:` prefix (`packages/web/src/routes/todos/task-page/activity.tsx:39`), and audit
event actors with that prefix (`whisper.tsx:87`).

### `SessionTreeResponse`

| Field | Type |
| --- | --- |
| `roots` | `SessionTreeNode[]` — sessions linked to this Todo, newest activity first |
| `directory` | `Record<string, SessionDirectoryEntry>` |
| `truncated` | `{ depth: boolean; count: boolean }` — whether either bound fired anywhere |
| `totals` | `{ nodes: number; live: number }` |

---

## State transitions

None. This feature introduces no state and no transition; it is a read surface (FR-011). The
states it *displays* are the session lifecycle states that already exist.

---

## Wire type changes (web)

`LinkedSessionWire` (`packages/web/src/lib/api.ts:677`) gains named fields for
`parentSessionId`, `workItemId`, `workItemRole`, and `archivedAt`. These already arrive — the
interface's index signature absorbs them today — so this names what is already on the wire and
adds nothing to the payload.
