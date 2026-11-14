import type { Database as DatabaseType } from "better-sqlite3";

/** How an attempt ended. Frozen: the DDL's CHECK pins the same six words, so a
 *  new one is a schema change, not a string.
 *
 *  `rate_limited` is deliberately not a failure: a quota window is the
 *  provider saying "not now", and recording it as `blocked` or `crashed` makes a
 *  wait look like a code problem to every reader and every counter downstream. */
export const TODO_RUN_OUTCOMES = ["completed", "blocked", "crashed", "timed_out", "abandoned", "rate_limited"] as const;

export type TodoRunOutcome = (typeof TODO_RUN_OUTCOMES)[number];

/** One row per work ATTEMPT. Which files an attempt changed and which
 *  tests it ran are run facts, not task facts — a retrying agent and a reviewer
 *  both need to read what the previous attempt already tried, and a scalar
 *  counter on the Todo cannot hold that.
 *
 *  Additive, never a column on `work_items`: the exact-shape verifier refuses
 *  any drift in an existing table, so a new table is the only extension a
 *  deployed database can survive.
 *
 *  `metadata` carries the structured handoff as JSON (`changed_files`,
 *  `verification`, `retry_notes`, `residual_risk`) rather than four columns, so
 *  a fifth handoff field later is a normalizer change and not a frozen-shape
 *  migration. The paired CHECK is the ledger's core invariant: a run is open
 *  (no end, no outcome) or settled (both), never half of each. */
export const WORK_ITEM_RUNS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS work_item_runs (
  id           TEXT PRIMARY KEY CHECK (id GLOB 'wir_[0-9a-f]*' AND length(id) = 16),
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  session_id   TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  ended_at     TEXT,
  outcome      TEXT CHECK (outcome IN ('completed','blocked','crashed','timed_out','abandoned','rate_limited')),
  summary      TEXT,
  metadata     TEXT,
  error        TEXT,
  CHECK ((ended_at IS NULL) = (outcome IS NULL))
)`;

export const WORK_ITEM_RUNS_DDL = `
${WORK_ITEM_RUNS_TABLE_DDL};
CREATE INDEX IF NOT EXISTS idx_wi_runs_item ON work_item_runs(work_item_id, started_at);
CREATE INDEX IF NOT EXISTS idx_wi_runs_open ON work_item_runs(session_id) WHERE ended_at IS NULL;
`;

interface WorkItemRunVerifyRow {
  work_item_id: string;
  ended_at: string | null;
  outcome: string | null;
  metadata: string | null;
}

/**
 * Data-level re-proof of the run ledger at boot (the DDL pins the shape, this
 * pins the rows): every run belongs to a live Todo, open and settled are the
 * only two states, a settled run's outcome is one of the frozen six, and a
 * stored handoff still parses as a JSON object. Returns false rather than
 * throwing so the caller keeps the single curated refusal message.
 */
export function workItemRunRowsAreSound(db: DatabaseType, hasWorkItem: (id: string) => boolean): boolean {
  const rows = db.prepare("SELECT work_item_id, ended_at, outcome, metadata FROM work_item_runs")
    .all() as WorkItemRunVerifyRow[];
  for (const row of rows) {
    if (!hasWorkItem(row.work_item_id)) return false;
    if ((row.ended_at === null) !== (row.outcome === null)) return false;
    if (row.outcome !== null && !(TODO_RUN_OUTCOMES as readonly string[]).includes(row.outcome)) return false;
    if (row.metadata !== null && !parsesAsJsonObject(row.metadata)) return false;
  }
  return true;
}

function parsesAsJsonObject(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}
