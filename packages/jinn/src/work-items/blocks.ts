import type { Database as DatabaseType } from "better-sqlite3";
import type { WorkItem, WorkItemStatus } from "./store.js";

/** Why a Todo is blocked. Frozen: the DDL's CHECK pins the same four words, so a
 *  new one is a schema change, not a string. */
export const BLOCK_KINDS = ["dependency", "needs_input", "capability", "transient"] as const;

export type BlockKind = (typeof BLOCK_KINDS)[number];

/** What a block means when its caller did not say. Surfacing to a human is the
 *  safe default; defaulting to `dependency` would put work back in a queue
 *  nobody asked to have it back in. */
export const DEFAULT_BLOCK_KIND: BlockKind = "needs_input";

/** Same-kind recurrences a Todo may accumulate before the block routes to
 *  the operator instead (blocked, as an escalation): block, unblock, re-block,
 *  unblock, re-block. */
export const BLOCK_RECURRENCE_LIMIT = 2;

/** ICI-730: one row per Todo that has ever been blocked — the kind of its latest
 *  block and how many times that same kind has come back.
 *
 *  Additive, never a column on `work_items`: the exact-shape verifier refuses any
 *  drift in an existing table, so a new table is the only extension a deployed
 *  database can survive.
 *
 *  The row deliberately OUTLIVES the unblock. A counter cleared when the Todo
 *  leaves `blocked` is the amnesia that lets a cron-unblock / agent-reblock cycle
 *  run unbounded; only a successful completion clears it. It does NOT outlive the
 *  Todo, though — unlike the run ledger this is derived state about a live item,
 *  meaningless once the row it counts against is gone, hence the cascade. */
export const WORK_ITEM_BLOCKS_DDL = `
CREATE TABLE IF NOT EXISTS work_item_blocks (
  work_item_id     TEXT PRIMARY KEY REFERENCES work_items(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('dependency','needs_input','capability','transient')),
  recurrences      INTEGER NOT NULL DEFAULT 0 CHECK (recurrences >= 0),
  first_blocked_at TEXT NOT NULL,
  last_blocked_at  TEXT NOT NULL
)`;

export interface WorkItemBlock {
  kind: BlockKind;
  recurrences: number;
}

export interface ResolvedBlock extends WorkItemBlock {
  /** Where this block actually lands, which is not always `blocked`. */
  target: WorkItemStatus;
  /** The loop breaker fired: this kind has come back once too often. */
  escalated: boolean;
}

/** The message every surface refuses an unknown kind with. */
export const BLOCK_KIND_ERROR = `blockKind must be one of ${BLOCK_KINDS.join(", ")}`;

/** `undefined` when the caller said nothing, `null` when it named a kind that
 *  does not exist — routing on a guess would park work where nobody chose. */
export function parseBlockKind(value: unknown): BlockKind | null | undefined {
  if (value === undefined) return undefined;
  return (BLOCK_KINDS as readonly unknown[]).includes(value) ? (value as BlockKind) : null;
}

/** The Todo's block record, or undefined when it has never been blocked (or a
 *  successful completion cleared it). Takes the caller's `db` so it reads inside
 *  the caller's transaction. */
export function readBlockRecord(db: DatabaseType, workItemId: string): WorkItemBlock | undefined {
  return db
    .prepare("SELECT kind, recurrences FROM work_item_blocks WHERE work_item_id = ?")
    .get(workItemId) as WorkItemBlock | undefined;
}

/**
 * Decide what a block does to the Todo. The count is 0 for a first block or a
 * change of kind — a different problem is a new problem, not a repeat — and one
 * higher otherwise. A repeat too many ends at the operator; a `dependency` goes
 * back to the work queue, because waiting on other work is not a question for a
 * human; every other kind parks in `blocked`.
 *
 * Reads inside the caller's transaction and writes nothing: `recordBlock`
 * commits the decision once the status write has succeeded.
 */
export function resolveBlock(db: DatabaseType, item: WorkItem, kind: BlockKind): ResolvedBlock {
  const previous = readBlockRecord(db, item.id);
  const recurrences = previous?.kind === kind ? previous.recurrences + 1 : 0;
  if (recurrences >= BLOCK_RECURRENCE_LIMIT) return { kind, recurrences, target: "blocked", escalated: true };
  const target = kind === "dependency" ? "backlog" : "blocked";
  return { kind, recurrences, target, escalated: false };
}

/** Record the block attempt. `first_blocked_at` survives both an unblock and a
 *  change of kind: it dates the Todo's block history, not the current kind. */
export function recordBlock(db: DatabaseType, workItemId: string, block: WorkItemBlock, at: string): void {
  db.prepare(
    `INSERT INTO work_item_blocks (work_item_id, kind, recurrences, first_blocked_at, last_blocked_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(work_item_id) DO UPDATE SET
       kind = excluded.kind, recurrences = excluded.recurrences, last_blocked_at = excluded.last_blocked_at`,
  ).run(workItemId, block.kind, block.recurrences, at, at);
}

/** Clear on successful completion only — the one outcome that says the blocks
 *  are behind this Todo. `cancelled` deliberately keeps the record. */
export function clearBlockRecord(db: DatabaseType, workItemId: string): void {
  db.prepare("DELETE FROM work_item_blocks WHERE work_item_id = ?").run(workItemId);
}
