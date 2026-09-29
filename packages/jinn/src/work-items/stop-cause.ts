import type { Database as DatabaseType } from "better-sqlite3";
import type { BlockKind } from "./blocks.js";

/** PLA-157: why a stopped Todo stopped, and what ends the wait.
 *
 *  A Todo held by a quota window and a Todo held by a human decision both sit in
 *  `blocked`/`escalated`, so the board cannot tell a clock-wait from a you-wait
 *  and its "N waiting" count is a lie. `parked_until` names the moment a
 *  clock-wait is over; `unblock_what`/`unblock_who` name the person and the act
 *  that ends a human-wait.
 *
 *  Additive, never columns on `work_items`: the exact-shape verifier refuses any
 *  drift in an existing table, so a new table is the only extension a deployed
 *  database can survive.
 *
 *  The row belongs to the stop, not to the Todo — `transition()` deletes it the
 *  moment the Todo is no longer stopped, so a countdown can never outlive the
 *  wait it was counting. */
export const WORK_ITEM_STOP_CAUSE_DDL = `
CREATE TABLE IF NOT EXISTS work_item_stop_cause (
  work_item_id TEXT PRIMARY KEY REFERENCES work_items(id) ON DELETE CASCADE,
  parked_until TEXT,
  unblock_what TEXT,
  unblock_who  TEXT,
  updated_at   TEXT NOT NULL
)`;

/** What has to happen, and who has to do it. Free text: the point is that a
 *  human reading the card knows whether it is their move. */
export interface TodoUnblockHint {
  what: string;
  who: string;
}

export interface TodoStopCause {
  /** ISO; present only while the park is still in the future. */
  parkedUntil?: string;
  unblockHint?: TodoUnblockHint;
}

/** The message every surface refuses a malformed hint with — one validator, so
 *  the HTTP route and the MCP tool cannot accept what the other rejects. */
export const UNBLOCK_HINT_ERROR =
  "unblockHint must be an object with non-empty what and who strings, and no other keys";

export const PARKED_UNTIL_ERROR = "parkedUntil must be an ISO-8601 timestamp";

/** a park lives on a stop, so any move that does not land in `blocked`
 *  or `escalated` deletes it on the same write. Accepting one there reported
 *  success for a park that never existed — the Todo stayed in the queue, and
 *  idle-capacity could start it the next minute. */
export const PARKED_UNTIL_NEEDS_STOP =
  "parkedUntil parks a Todo in blocked (or escalated) and is deleted by any other move — send status: blocked without blockKind dependency, which re-queues instead of parking";

/** Whether a move to `target` keeps a park: it has to stop the Todo, and a
 *  `dependency` block does not — it re-queues. */
export function moveCanHoldPark(target: string, blockKind: BlockKind | undefined): boolean {
  if (target === "escalated") return true;
  return target === "blocked" && blockKind !== "dependency";
}

/** Why a `parkedUntil` on this move is refused, or undefined when it is fine
 *  (or absent). One rule, so the route and the MCP tool cannot disagree about
 *  which parks are real. */
export function parkRefusal(value: unknown, target: string, blockKind: BlockKind | undefined): string | undefined {
  const parkedUntil = parseParkedUntil(value);
  if (parkedUntil === null) return PARKED_UNTIL_ERROR;
  return parkedUntil && !moveCanHoldPark(target, blockKind) ? PARKED_UNTIL_NEEDS_STOP : undefined;
}

export const UNBLOCK_HINT_REQUIRED =
  "unblockHint {what, who} is required when escalating a Todo — an escalation nobody can act on is not an escalation";

const UNBLOCK_HINT_KEYS = ["what", "who"] as const;

/** `undefined` when the caller said nothing, `null` when what it said is not a
 *  hint — an escalation stored with half a hint reads as an answer nobody gave. */
export function parseUnblockHint(value: unknown): TodoUnblockHint | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entries = value as Record<string, unknown>;
  if (Object.keys(entries).some((key) => !(UNBLOCK_HINT_KEYS as readonly string[]).includes(key))) return null;
  const what = entries.what;
  const who = entries.who;
  if (typeof what !== "string" || typeof who !== "string") return null;
  if (!what.trim() || !who.trim()) return null;
  return { what: what.trim(), who: who.trim() };
}

/** `undefined` when the caller said nothing, `null` when the value is not a
 *  timestamp this process can compare against the clock. */
export function parseParkedUntil(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

/** Expiry is what the clock says, not what a sweeper got around to. A park that
 *  has passed — or one that will not parse, because fail-open is the only safe
 *  direction for a field that hides work from the operator — is not a park. */
export function isParked(parkedUntil: string | null | undefined, now = Date.now()): boolean {
  if (!parkedUntil) return false;
  const at = Date.parse(parkedUntil);
  return !Number.isNaN(at) && at > now;
}

interface StopCauseRow {
  parked_until: string | null;
  unblock_what: string | null;
  unblock_who: string | null;
}

function rowToStopCause(row: StopCauseRow, now: number): TodoStopCause | undefined {
  const parkedUntil = isParked(row.parked_until, now) ? row.parked_until ?? undefined : undefined;
  const hint = row.unblock_what && row.unblock_who ? { what: row.unblock_what, who: row.unblock_who } : undefined;
  if (!parkedUntil && !hint) return undefined;
  return { ...(parkedUntil ? { parkedUntil } : {}), ...(hint ? { unblockHint: hint } : {}) };
}

/** The Todo's stop cause, or undefined when it has none left to tell. Takes the
 *  caller's `db` so it reads inside the caller's transaction. */
export function readStopCause(db: DatabaseType, workItemId: string, now = Date.now()): TodoStopCause | undefined {
  const row = db
    .prepare("SELECT parked_until, unblock_what, unblock_who FROM work_item_stop_cause WHERE work_item_id = ?")
    .get(workItemId) as StopCauseRow | undefined;
  return row ? rowToStopCause(row, now) : undefined;
}

/** Replace the Todo's stop cause. Called inside the status write's transaction,
 *  so the cause and the stop it explains commit together or not at all. */
export function writeStopCause(db: DatabaseType, workItemId: string, cause: TodoStopCause, at: string): void {
  db.prepare(
    `INSERT INTO work_item_stop_cause (work_item_id, parked_until, unblock_what, unblock_who, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(work_item_id) DO UPDATE SET
       parked_until = excluded.parked_until, unblock_what = excluded.unblock_what,
       unblock_who = excluded.unblock_who, updated_at = excluded.updated_at`,
  ).run(workItemId, cause.parkedUntil ?? null, cause.unblockHint?.what ?? null, cause.unblockHint?.who ?? null, at);
}

/** Drop the cause when the Todo is no longer stopped. Unlike the block record
 *  this does NOT survive the unblock: it describes one wait, and that wait is
 *  over the moment the Todo moves. */
export function clearStopCause(db: DatabaseType, workItemId: string): void {
  db.prepare("DELETE FROM work_item_stop_cause WHERE work_item_id = ?").run(workItemId);
}
