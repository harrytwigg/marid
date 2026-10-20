import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { WORK_ITEM_RUNS_TABLE_DDL } from "../runs-schema.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-runs-schema-"));
process.env.JINN_HOME = tmp;

type Migrate = typeof import("../migrate.js");
let migrate: Migrate;

beforeAll(async () => {
  migrate = await import("../migrate.js");
});

/** A clean current-shape database, built the way the gateway builds one. */
function freshDatabase(name: string): { file: string; db: import("better-sqlite3").Database } {
  const file = path.join(tmp, name);
  const db = new Database(file);
  migrate.migrateWorkItemsSchema(db, "absent");
  return { file, db };
}

describe("work_item_runs in the frozen schema", () => {
  it("is created on a fresh database with the exact frozen DDL and verifies", () => {
    const { db } = freshDatabase("fresh.db");
    const stored = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'work_item_runs'")
      .get() as { sql: string }).sql;
    const shape = (sql: string) => sql.replace(/\bIF\s+NOT\s+EXISTS\b/gi, "").replace(/\s+/g, " ").trim().toLowerCase();
    expect(shape(stored)).toBe(shape(WORK_ITEM_RUNS_TABLE_DDL));
    expect(() => migrate.verifyCurrentWorkItemSchema(db)).not.toThrow();
    db.close();
  });

  it("heals a v2 database that predates the table, and still verifies", () => {
    const { file, db } = freshDatabase("heal.db");
    db.exec("DROP TABLE work_item_runs");
    expect(() => migrate.verifyCurrentWorkItemSchema(db)).toThrow(migrate.UNSUPPORTED_PRERELEASE_TODO_DATA);
    db.close();

    expect(migrate.preflightWorkItemsDatabase(file)).toBe("current");

    const healed = new Database(file);
    expect(migrate.migrateWorkItemsSchema(healed, "current").rebuilt).toBe(false);
    expect(() => migrate.verifyCurrentWorkItemSchema(healed)).not.toThrow();
    healed.close();
  });

  it("refuses at preflight when the table exists with a different shape", () => {
    const { file, db } = freshDatabase("drift.db");
    db.exec("DROP TABLE work_item_runs");
    db.exec("CREATE TABLE work_item_runs (id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL, outcome TEXT)");
    db.close();
    expect(() => migrate.preflightWorkItemsDatabase(file)).toThrow(migrate.UNSUPPORTED_PRERELEASE_TODO_DATA);
  });

  it("refuses a run row whose outcome is outside the six the ledger knows", () => {
    const { db } = freshDatabase("bad-outcome.db");
    // The CHECK stops the honest write path; the boot verifier re-proves the
    // data for a database that reached this state some other way.
    expect(() =>
      db.prepare(
        `INSERT INTO work_item_runs (id, work_item_id, session_id, started_at, ended_at, outcome)
         VALUES ('wir_00000000000a', 'JIN-1', 's', '2026-08-13T00:00:00.000Z', '2026-08-13T00:01:00.000Z', 'succeeded')`,
      ).run(),
    ).toThrow(/CHECK/i);
    db.close();
  });

  it("refuses a half-settled run: an end without an outcome, or an outcome without an end", () => {
    const { db } = freshDatabase("half.db");
    const insert = (endedAt: string | null, outcome: string | null) =>
      db.prepare(
        `INSERT INTO work_item_runs (id, work_item_id, session_id, started_at, ended_at, outcome)
         VALUES ('wir_00000000000b', 'JIN-1', 's', '2026-08-13T00:00:00.000Z', ?, ?)`,
      ).run(endedAt, outcome);
    expect(() => insert("2026-08-13T00:01:00.000Z", null)).toThrow(/CHECK/i);
    expect(() => insert(null, "completed")).toThrow(/CHECK/i);
    db.close();
  });

  it("accepts a rate_limited run, and the boot verifier is happy with it", () => {
    const { db } = freshDatabase("rate-limited.db");
    const host = seedItem(db);
    expect(() =>
      db.prepare(
        `INSERT INTO work_item_runs (id, work_item_id, session_id, started_at, ended_at, outcome)
         VALUES ('wir_00000000000c', ?, 's', '2026-08-13T00:00:00.000Z', '2026-08-13T00:01:00.000Z', 'rate_limited')`,
      ).run(host),
    ).not.toThrow();
    expect(() => migrate.verifyCurrentWorkItemSchema(db)).not.toThrow();
    db.close();
  });
});

/** One Todo to hang runs off: the boot verifier refuses a run whose Todo is not
 *  there, so a run-row test needs a real row (the idiom in migrate-v2.test.ts). */
function seedItem(db: import("better-sqlite3").Database): string {
  const base = "2026-08-13T00:00:00.000Z";
  const claim = migrate.allocateWorkItemId(db, base, "ACM");
  migrate.useWorkItemAllocationClaim(db, claim, () => {
    db.prepare(
      `INSERT INTO work_items (id, title, status, priority, version, source, rounds, created_by, root_id, depth, created_at, updated_at)
       VALUES (?, 'run host', 'executing', 2, 1, 'human', 0, 'operator', ?, 0, ?, ?)`,
    ).run(claim.id, claim.id, base, base);
  });
  return claim.id;
}

/** The shape the ledger first shipped: the same table with five outcomes in its CHECK.
 *  Derived from the current DDL rather than copied, so the day someone edits the
 *  table for an unrelated reason this stops matching migrate.ts's own frozen
 *  literal and the recognizer test goes red instead of quietly passing. */
const FIVE_OUTCOME_RUNS_SQL = WORK_ITEM_RUNS_TABLE_DDL.replace(",'rate_limited'", "");

describe("widening the run outcomes on a deployed database", () => {
  /** A current database wound back to the five-outcome run table, rows and all. */
  function fiveOutcomeDatabase(name: string): { file: string; host: string } {
    const { file, db } = freshDatabase(name);
    const host = seedItem(db);
    db.exec("DROP TABLE work_item_runs");
    db.exec(FIVE_OUTCOME_RUNS_SQL);
    db.prepare(
      `INSERT INTO work_item_runs (id, work_item_id, session_id, started_at, ended_at, outcome, summary, error)
       VALUES ('wir_0000000000a1', @host, 's-1', '2026-08-13T00:00:00.000Z', '2026-08-13T00:05:00.000Z', 'completed', 'shipped', NULL),
              ('wir_0000000000a2', @host, 's-2', '2026-08-13T01:00:00.000Z', NULL, NULL, NULL, NULL)`,
    ).run({ host });
    db.close();
    return { file, host };
  }

  it("is recognized at preflight rather than refused", () => {
    expect(migrate.preflightWorkItemsDatabase(fiveOutcomeDatabase("five-preflight.db").file)).toBe("current");
  });

  it("migrates to the six-outcome shape with every run row preserved, and verifies", () => {
    const { file, host } = fiveOutcomeDatabase("five-migrate.db");
    const db = new Database(file);
    migrate.migrateWorkItemsSchema(db, "current");

    const stored = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'work_item_runs'")
      .get() as { sql: string }).sql;
    expect(stored).toContain("rate_limited");
    expect(db.prepare("SELECT id, outcome, summary FROM work_item_runs ORDER BY id").all()).toEqual([
      { id: "wir_0000000000a1", outcome: "completed", summary: "shipped" },
      { id: "wir_0000000000a2", outcome: null, summary: null },
    ]);
    // A rename carries the old indexes along under their own names; both have to
    // be back on the NEW table or the ledger silently loses them.
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'work_item_runs' AND name LIKE 'idx_%' ORDER BY name")
      .pluck().all()).toEqual(["idx_wi_runs_item", "idx_wi_runs_open"]);
    expect(() => migrate.verifyCurrentWorkItemSchema(db)).not.toThrow();

    // The widened CHECK is the point: the outcome the old shape refused now writes.
    expect(() =>
      db.prepare(
        `INSERT INTO work_item_runs (id, work_item_id, session_id, started_at, ended_at, outcome)
         VALUES ('wir_0000000000a3', ?, 's-3', '2026-08-13T02:00:00.000Z', '2026-08-13T02:01:00.000Z', 'rate_limited')`,
      ).run(host),
    ).not.toThrow();
    db.close();
  });

  it("leaves an already-current database alone", () => {
    const { file, db } = freshDatabase("already-six.db");
    db.close();
    const again = new Database(file);
    expect(migrate.migrateWorkItemsSchema(again, "current")).toEqual({ rebuilt: false, rows: 0 });
    expect(() => migrate.verifyCurrentWorkItemSchema(again)).not.toThrow();
    again.close();
  });
});
