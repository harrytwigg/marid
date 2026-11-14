import type Database from 'better-sqlite3';

/**
 * Every turn's cost, with the moment it was spent.
 *
 * `sessions.total_cost` is a running total per session: it answers "what has
 * this session cost", never "what was spent in the last five hours", and a
 * windowed allowance is only ever the second question. An engine with no quota
 * endpoint of its own (opencode) can still be metered against its provider's
 * published windows, but only from spend that carries a timestamp — so each
 * turn that cost anything also lands here.
 *
 * Written for every engine, because the turn path does not know which engines
 * someone will want to meter; read only by the collectors that meter one.
 *
 * Deliberately no foreign key to `sessions`: deleting a session does not give
 * back the allowance it spent, and the window has to keep counting it.
 */

export const CREATE_ENGINE_SPEND_TABLE = `
CREATE TABLE IF NOT EXISTS engine_spend (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  engine TEXT NOT NULL,
  model TEXT,
  cost REAL NOT NULL,
  at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_engine_spend_engine_at ON engine_spend (engine, at_ms)
`;

/** How long a row is kept: the longest window anything meters (thirty days),
 *  with a margin so a window read just after a prune is never short. */
export const ENGINE_SPEND_RETENTION_MS = 35 * 24 * 60 * 60_000;

/** Pruning is a courtesy to the file, not a correctness step — readers bound
 *  their own window — so it runs at most this often per process. */
const PRUNE_INTERVAL_MS = 60 * 60_000;
let lastPruneMs = 0;

/**
 * Record one turn's spend against the engine the session row names AT THIS
 * MOMENT, and the model the turn ran on. The row's engine is the one that
 * actually ran: a rate-limit substitution rewrites it before its turn settles,
 * so a Claude session whose turn ran on opencode is charged to opencode.
 *
 * The model is the caller's `ranOn` — what the engine was actually handed —
 * because an unpinned session's row carries no model, and resolving one later
 * would charge old spend to whatever the default is by then. The row's own
 * model is the fallback for a caller that could not say.
 *
 * A turn that cost nothing is not a row: it spent no allowance.
 */
export function recordEngineSpend(
  database: Database.Database,
  sessionId: string,
  cost: number,
  atMs: number,
  ranOn?: string,
): void {
  if (!(cost > 0) || !Number.isFinite(cost)) return;
  database.prepare(
    `INSERT INTO engine_spend (session_id, engine, model, cost, at_ms)
     SELECT id, engine, COALESCE(?, model), ?, ? FROM sessions WHERE id = ?`,
  ).run(ranOn ?? null, cost, atMs, sessionId);
  if (atMs - lastPruneMs >= PRUNE_INTERVAL_MS) {
    lastPruneMs = atMs;
    database.prepare('DELETE FROM engine_spend WHERE at_ms < ?').run(atMs - ENGINE_SPEND_RETENTION_MS);
  }
}

export interface EngineSpendRow {
  /** The model the turn ran on; null only when neither the caller nor the
   *  session row could name one. */
  model: string | null;
  cost: number;
  atMs: number;
}

/** An engine's spend since `sinceMs`, oldest first. */
export function readEngineSpend(database: Database.Database, engine: string, sinceMs: number): EngineSpendRow[] {
  return database.prepare(
    `SELECT model, cost, at_ms AS atMs FROM engine_spend
     WHERE engine = ? AND at_ms > ? ORDER BY at_ms ASC, id ASC`,
  ).all(engine, sinceMs) as EngineSpendRow[];
}

/** Test seam: let the next write prune regardless of when the last one did. */
export function __resetEngineSpendPruneForTest(): void {
  lastPruneMs = 0;
}
