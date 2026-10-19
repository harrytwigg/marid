import type { Database as DatabaseType } from "better-sqlite3";
import { WORK_ITEM_RUNS_DDL, WORK_ITEM_RUNS_TABLE_DDL } from "./runs-schema.js";
import { currentTableSql, sqlShape } from "./sql-shape.js";

/**
 * The run ledger's schema history.
 *
 * `work_item_runs` is the one Todo table whose shape has changed since it
 * shipped, and it lives here rather than in the boot migration because the
 * reason it changed is the ledger's own vocabulary: `rate_limited` joined the
 * outcomes. The boot migration calls both of these and knows nothing else about
 * it.
 */

/** The shape the ledger first shipped, before `rate_limited` joined the outcome
 *  taxonomy. Frozen, and written out rather than derived: it is the literal SQL
 *  a deployed database still stores, and a recognizer that regenerated it from
 *  the current constant would stop recognizing anything. */
const FIVE_OUTCOME_WORK_ITEM_RUNS_TABLE_SQL = `
CREATE TABLE work_item_runs (
  id           TEXT PRIMARY KEY CHECK (id GLOB 'wir_[0-9a-f]*' AND length(id) = 16),
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  session_id   TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  ended_at     TEXT,
  outcome      TEXT CHECK (outcome IN ('completed','blocked','crashed','timed_out','abandoned')),
  summary      TEXT,
  metadata     TEXT,
  error        TEXT,
  CHECK ((ended_at IS NULL) = (outcome IS NULL))
)`;

/** Whether this database's run ledger still pins the five outcomes it shipped
 *  with — a healable defect, not a refusal. */
export function hasFiveOutcomeRunTable(db: DatabaseType): boolean {
  return sqlShape(currentTableSql(db, "work_item_runs")) === sqlShape(FIVE_OUTCOME_WORK_ITEM_RUNS_TABLE_SQL);
}

/**
 * Widen the run-outcome CHECK to admit `rate_limited`. SQLite cannot ALTER a
 * CHECK and the boot verifier compares stored SQL with zero tolerance, so this
 * is a table rebuild: rename, recreate at the canonical shape, copy every row,
 * drop the legacy table. The indexes come last on purpose — a rename carries
 * them along under their original names, so they have to die with the legacy
 * table before the canonical DDL can mint them again.
 *
 * The caller runs this inside the migration transaction, so a failure anywhere
 * leaves the old table exactly as it was.
 */
export function widenRunOutcomes(db: DatabaseType): void {
  db.exec("ALTER TABLE work_item_runs RENAME TO work_item_runs_legacy");
  db.exec(WORK_ITEM_RUNS_TABLE_DDL);
  db.exec(`INSERT INTO work_item_runs
      (id, work_item_id, session_id, started_at, ended_at, outcome, summary, metadata, error)
    SELECT id, work_item_id, session_id, started_at, ended_at, outcome, summary, metadata, error
      FROM work_item_runs_legacy`);
  db.exec("DROP TABLE work_item_runs_legacy");
  db.exec(WORK_ITEM_RUNS_DDL);
}
