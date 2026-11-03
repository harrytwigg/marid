# Data Model: Cloud Handoff

**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md)

## Table `cloud_handoffs`

This is a new table, added through the gateway's migration bundle. One row is one fire.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | TEXT PK | `cho_<12 hex>`, an internal id. Never sent to the cloud or to GitHub |
| `nonce` | TEXT UNIQUE NOT NULL | 24 hex (96 bits), random. It is the only id that leaves the gateway: in the branch name and the result block |
| `session_id` | TEXT NOT NULL | The owning gateway session |
| `work_item_id` | TEXT NULL | The Todo, when the session is linked to one |
| `target` | TEXT NOT NULL | The target name from config |
| `repo` | TEXT NOT NULL | `owner/name`, copied from the target when the row is opened |
| `branch` | TEXT NOT NULL | `<branchPrefix><nonce>` |
| `continues_handoff_id` | TEXT NULL | Set when this fire continues an earlier handoff's branch (FR-018) |
| `state` | TEXT NOT NULL | See the states below |
| `cloud_session_id` | TEXT NULL | From the fire answer |
| `cloud_session_url` | TEXT NULL | From the fire answer |
| `pr_url` | TEXT NULL | Set once the watcher sees a PR |
| `result_status` | TEXT NULL | `done`, `blocked` or `failed`, from the block |
| `result_summary` | TEXT NULL | Clipped to 4,000 characters |
| `error` | TEXT NULL | For the fire failure, the timeout or the abandon |
| `opened_at` | TEXT NOT NULL | ISO 8601 |
| `fired_at` | TEXT NULL | Counts toward `maxPerDay` (by UTC date) |
| `next_poll_at` | TEXT NULL | The watcher's schedule. Null once the handoff is closed |
| `closed_at` | TEXT NULL | Set if and only if the state is terminal |

Indexes: `(session_id, closed_at)` for re-attach; `(closed_at, next_poll_at)` for the
watcher; `(fired_at)` for the daily cap.

CHECK: `(closed_at IS NULL) = (state IN ('opened','fired','fired-unconfirmed'))`. This
mirrors the run ledger's rule (`packages/jinn/src/work-items/runs-schema.ts`).

## States

```text
opened ──fire 200──▶ fired ──block "done"────▶ done
   │                   │──block "blocked"─▶ blocked
   │                   │──block "failed"──▶ failed
   │                   │──timeout─────────▶ timed-out
   │                   └──stop────────────▶ abandoned
   ├──fire 4xx (not 429)──────▶ failed
   ├──fire 429────────────────▶ failed (error: rate-limited; the turn waits and opens a new row)
   └──fire 5xx or no response─▶ fired-unconfirmed ──block / stop / timeout──▶ done… / abandoned / timed-out
```

- `opened` exists only between the cap check and the fire. It is written in the same
  transaction as the cap check, so two turns cannot both pass a cap of one.
- `fired-unconfirmed` is never retried automatically (FR-015). It is open, so it counts
  toward `maxConcurrent` until it times out or is stopped. The watcher still polls its
  branch, because the fire may have landed. A valid block on that branch closes it like
  `fired`.
- At most one open row exists per session. A turn that finds one re-attaches instead of
  opening another (FR-017). A partial unique index on `(session_id) WHERE closed_at IS NULL`
  enforces this.
- A row is closed exactly once. A result seen after `abandoned` is not written.

## The handoff on the session

Nothing new is added to the `sessions` table.

- The cloud session id is filed in the existing engine-session slot under `claude-cloud`
  (`EngineSessionRef`, `packages/jinn/src/shared/types.ts:340`) from `EngineResult.sessionId`.
- The session view reads the open or latest handoff by `session_id`.

## Phase 2: the Todo run

Phase 2 fills `summary` and `handoff` on the existing `work_item_runs` row when the turn
settles:

- `summary` is the result summary;
- `handoff.changedFiles` comes from the PR files API;
- `handoff.verification` comes from the block's `verification` field;
- `handoff.residualRisk` comes from the block's `risks` field.

The run's `outcome` mapping is unchanged.
