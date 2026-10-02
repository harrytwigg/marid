import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it, vi } from "vitest";

// The schema the removed Experiments feature created, including its three
// indexes. SQLite drops a table's indexes with it, so the drop step names only
// the three tables.
const LEGACY_SCHEMA = `
CREATE TABLE experiments (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, hypothesis TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'concluded')),
  started_at TEXT NOT NULL, horizon_days INTEGER NOT NULL CHECK (horizon_days > 0),
  baseline_json TEXT NOT NULL, verdict_outcome TEXT, verdict_note TEXT, concluded_at TEXT,
  check_in_cron_job_id TEXT, todo_id TEXT, owner TEXT
);
CREATE TABLE experiment_metrics (
  experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL, name TEXT NOT NULL, unit TEXT, how_to_measure TEXT NOT NULL,
  PRIMARY KEY (experiment_id, name)
);
CREATE TABLE experiment_readings (
  id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL, at TEXT NOT NULL, metric TEXT NOT NULL,
  value REAL NOT NULL, note TEXT,
  FOREIGN KEY (experiment_id, metric) REFERENCES experiment_metrics(experiment_id, name) ON DELETE CASCADE
);
CREATE INDEX idx_experiments_status_started ON experiments(status, started_at DESC);
CREATE INDEX idx_experiment_metrics_order ON experiment_metrics(experiment_id, ordinal);
CREATE INDEX idx_experiment_readings_order ON experiment_readings(experiment_id, at, id);
`;

const WITH_ROWS = `${LEGACY_SCHEMA}
INSERT INTO experiments (id, name, hypothesis, started_at, horizon_days, baseline_json, check_in_cron_job_id)
VALUES ('exp_aaaaaaaaaaaa', 'Legacy', 'A hypothesis.', '2026-07-01T09:00:00.000Z', 30, '{"activation":21}',
        'experiment-check-in-exp_aaaaaaaaaaaa');
INSERT INTO experiment_metrics VALUES ('exp_aaaaaaaaaaaa', 0, 'activation', '%', 'Read the dashboard.');
INSERT INTO experiment_readings VALUES ('rd_aaaaaaaaaaaa', 'exp_aaaaaaaaaaaa', '2026-07-08T09:00:00.000Z', 'activation', 23, NULL);
`;

const originalHome = process.env.JINN_HOME;
const homes: string[] = [];

afterAll(() => {
  if (originalHome === undefined) delete process.env.JINN_HOME;
  else process.env.JINN_HOME = originalHome;
  for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
});

const dbPath = (home: string): string => path.join(home, "sessions", "registry.db");

/** A throwaway home, optionally pre-seeded with the legacy Experiments schema. */
function makeHome(seed?: string): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-expdrop-"));
  homes.push(home);
  if (seed !== undefined) {
    fs.mkdirSync(path.dirname(dbPath(home)), { recursive: true });
    const database = new Database(dbPath(home));
    database.exec(seed);
    database.close();
  }
  return home;
}

/** Boot the database against `home` in a fresh module graph — SESSIONS_DB is
 * resolved once per module instance from JINN_HOME. */
async function bootRegistry(home: string): Promise<void> {
  process.env.JINN_HOME = home;
  vi.resetModules();
  const dbModule = await import("../../shared/db.js");
  dbModule.initDb();
  dbModule.__closeDbForTest();
}

function readHome<T>(home: string, sql: string): T[] {
  const database = new Database(dbPath(home), { readonly: true });
  try { return database.prepare(sql).pluck().all() as T[]; } finally { database.close(); }
}

/** Every surviving experiment table and index. */
const experimentSchemaIn = (home: string): string[] =>
  readHome(home, "SELECT name FROM sqlite_master WHERE name LIKE '%experiment%' ORDER BY name");

describe("experiments schema drop", () => {
  it("creates no experiment object on a fresh home", async () => {
    const home = makeHome();
    await bootRegistry(home);
    expect(experimentSchemaIn(home)).toEqual([]);
  });

  it("drops the tables and their indexes from a home with no rows", async () => {
    const home = makeHome(LEGACY_SCHEMA);
    expect(experimentSchemaIn(home)).toHaveLength(9); // 3 tables + 3 indexes + 3 primary-key autoindexes
    await bootRegistry(home);
    expect(experimentSchemaIn(home)).toEqual([]);
  });

  it("drops the tables even when they hold rows", async () => {
    const home = makeHome(WITH_ROWS);
    expect(readHome(home, "SELECT COUNT(*) FROM experiment_readings")).toEqual([1]);
    await bootRegistry(home);
    expect(experimentSchemaIn(home)).toEqual([]);
  });

  it("is a no-op on the second boot", async () => {
    const home = makeHome(WITH_ROWS);
    await bootRegistry(home);
    const afterFirst = readHome(home, "SELECT name FROM sqlite_master ORDER BY name");
    await bootRegistry(home);
    expect(readHome(home, "SELECT name FROM sqlite_master ORDER BY name")).toEqual(afterFirst);
  });
});
