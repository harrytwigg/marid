import { randomUUID } from "node:crypto";
import { initDb } from "../shared/db.js";
import type { ActionOutcome, HookRun, HookRunAction, HookRunStatus } from "./types.js";

/** Rows older than this, and rows beyond the newest {@link RETENTION_ROWS}, are pruned. */
export const RETENTION_MS = 30 * 24 * 60 * 60_000;
export const RETENTION_ROWS = 10_000;
/** Pruning runs at write time, at most this often per process. */
const PRUNE_INTERVAL_MS = 60 * 60_000;
let lastPruneMs = 0;

interface RunRow {
  id: string; fire_id: string; hook: string; event: string; event_id: string; todo_id: string;
  action: HookRunAction; status: HookRunStatus; session_id: string | null; exit_code: number | null;
  error: string | null; output: string | null; payload: string; chain: string;
  started_at: string; finished_at: string | null; started_ms: number;
}

export interface NewRun {
  fireId: string;
  hook: string;
  event: string;
  eventId: string;
  todoId: string;
  action: HookRunAction;
  status: HookRunStatus;
  payload: unknown;
  chain: string[];
  error?: string;
}

function rowToRun(row: RunRow, detail: boolean): HookRun {
  const run: HookRun = {
    id: row.id, fireId: row.fire_id, hook: row.hook, event: row.event, eventId: row.event_id, todoId: row.todo_id,
    action: row.action, status: row.status, sessionId: row.session_id, exitCode: row.exit_code, error: row.error,
    chain: JSON.parse(row.chain) as string[], startedAt: row.started_at, finishedAt: row.finished_at, startedMs: row.started_ms,
  };
  if (!detail) return run;
  return { ...run, output: row.output, payload: JSON.parse(row.payload) as unknown };
}

/** Delete rows past retention. Running rows stay: their action will still write its outcome. */
export function pruneRuns(nowMs: number): void {
  const db = initDb();
  db.prepare("DELETE FROM board_hook_runs WHERE status <> 'running' AND started_ms < ?").run(nowMs - RETENTION_MS);
  db.prepare(
    `DELETE FROM board_hook_runs WHERE status <> 'running' AND rowid NOT IN
       (SELECT rowid FROM board_hook_runs ORDER BY started_ms DESC, rowid DESC LIMIT ?)`,
  ).run(RETENTION_ROWS);
}

function pruneIfDue(nowMs: number): void {
  if (nowMs - lastPruneMs < PRUNE_INTERVAL_MS) return;
  lastPruneMs = nowMs;
  pruneRuns(nowMs);
}

/** Test seam: let the next write prune regardless of when the last one did. */
export function __resetBoardHookPruneForTest(): void {
  lastPruneMs = 0;
}

export function insertRun(run: NewRun, nowMs = Date.now()): string {
  const id = `bhr_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const now = new Date(nowMs).toISOString();
  const finished = run.status === "running" ? null : now;
  initDb().prepare(
    `INSERT INTO board_hook_runs
       (id, fire_id, hook, event, event_id, todo_id, action, status, error, payload, chain, started_at, finished_at, started_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, run.fireId, run.hook, run.event, run.eventId, run.todoId, run.action, run.status, run.error ?? null,
    JSON.stringify(run.payload), JSON.stringify(run.chain), now, finished, nowMs,
  );
  pruneIfDue(nowMs);
  return id;
}

/** Record how a running action ended. A row that is not running any more is left alone. */
export function finishRun(id: string, outcome: ActionOutcome): HookRunStatus | undefined {
  const result = initDb().prepare(
    `UPDATE board_hook_runs SET status = ?, session_id = COALESCE(?, session_id), exit_code = ?, error = ?, output = ?, finished_at = ?
     WHERE id = ? AND status = 'running'`,
  ).run(outcome.status, outcome.sessionId ?? null, outcome.exitCode ?? null, outcome.error ?? null, outcome.output ?? null, new Date().toISOString(), id);
  return result.changes > 0 ? outcome.status : undefined;
}

/** At boot: whatever a previous process left `running` can no longer finish. */
export function interruptLeftoverRuns(): number {
  const result = initDb().prepare(
    `UPDATE board_hook_runs SET status = 'interrupted', finished_at = ?, error = COALESCE(error, 'the gateway stopped before this action finished')
     WHERE status = 'running'`,
  ).run(new Date().toISOString());
  return result.changes;
}

export interface RunFilter {
  hook?: string;
  status?: HookRunStatus;
  todo?: string;
  limit?: number;
  before?: string;
}

export const RUN_PAGE_DEFAULT = 50;
export const RUN_PAGE_MAX = 200;

function filterClause(filter: RunFilter): { where: string; args: unknown[] } {
  const conditions: string[] = [];
  const args: unknown[] = [];
  for (const [column, value] of [["hook", filter.hook], ["status", filter.status], ["todo_id", filter.todo]] as const) {
    if (value === undefined) continue;
    conditions.push(`${column} = ?`);
    args.push(value);
  }
  if (filter.before) {
    const cursor = initDb().prepare("SELECT started_ms, rowid AS rid FROM board_hook_runs WHERE id = ?").get(filter.before) as { started_ms: number; rid: number } | undefined;
    // An unknown cursor (pruned since the page was served) ends the listing rather than restarting it.
    conditions.push(cursor ? "(started_ms, rowid) < (?, ?)" : "0");
    if (cursor) args.push(cursor.started_ms, cursor.rid);
  }
  return { where: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "", args };
}

/** Newest first. `nextBefore` is the cursor for the next page, or null at the end. List rows carry no payload or output. */
export function listRuns(filter: RunFilter): { runs: HookRun[]; nextBefore: string | null } {
  const limit = Math.min(RUN_PAGE_MAX, Math.max(1, Math.floor(filter.limit ?? RUN_PAGE_DEFAULT)));
  const { where, args } = filterClause(filter);
  const rows = initDb().prepare(
    `SELECT * FROM board_hook_runs ${where} ORDER BY started_ms DESC, rowid DESC LIMIT ?`,
  ).all(...args, limit + 1) as RunRow[];
  const page = rows.slice(0, limit);
  return { runs: page.map((row) => rowToRun(row, false)), nextBefore: rows.length > limit ? page[page.length - 1].id : null };
}

export function getRun(id: string): HookRun | undefined {
  const row = initDb().prepare("SELECT * FROM board_hook_runs WHERE id = ?").get(id) as RunRow | undefined;
  return row ? rowToRun(row, true) : undefined;
}

/** The newest run a hook wrote, for the hooks list. */
export function lastRunOf(hook: string): { startedAt: string; status: HookRunStatus } | undefined {
  const row = initDb().prepare(
    "SELECT started_at, status FROM board_hook_runs WHERE hook = ? ORDER BY started_ms DESC, rowid DESC LIMIT 1",
  ).get(hook) as { started_at: string; status: HookRunStatus } | undefined;
  return row ? { startedAt: row.started_at, status: row.status } : undefined;
}

/** The chain a hook's spawn recorded, found by the fire id its session's `sourceRef` carries. */
export function chainOfFire(fireId: string): string[] {
  const row = initDb().prepare(
    "SELECT chain FROM board_hook_runs WHERE fire_id = ? AND action = 'spawn' ORDER BY started_ms DESC, rowid DESC LIMIT 1",
  ).get(fireId) as { chain: string } | undefined;
  return row ? (JSON.parse(row.chain) as string[]) : [];
}
