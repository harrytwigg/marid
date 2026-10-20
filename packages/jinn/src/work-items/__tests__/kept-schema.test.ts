import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { WORK_ITEM_KEPT_DDL } from "../kept.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-kept-schema-"));
process.env.JINN_HOME = tmp;

type Migrate = typeof import("../migrate.js");
let migrate: Migrate;

beforeAll(async () => {
  migrate = await import("../migrate.js");
});

const shape = (sql: string | undefined) =>
  (sql ?? "").replace(/\bIF\s+NOT\s+EXISTS\b/gi, "").replace(/\s+/g, " ").replace(/;\s*$/, "").trim().toLowerCase();

function freshDatabase(name: string): { file: string; db: import("better-sqlite3").Database } {
  const file = path.join(tmp, name);
  const db = new Database(file);
  migrate.migrateWorkItemsSchema(db, "absent");
  return { file, db };
}

function storedSql(db: import("better-sqlite3").Database, table: string): string | undefined {
  return (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string } | undefined)?.sql;
}

const SEEDED_AT = "2026-01-01T00:00:00.000Z";

/** One real Todo through the allocator, so the identity triggers are satisfied. */
function seed(db: import("better-sqlite3").Database, createdBy: string): string {
  migrate.registerWorkItemIdentityFunctions(db);
  const claim = migrate.allocateWorkItemId(db, SEEDED_AT, "JIN");
  migrate.useWorkItemAllocationClaim(db, claim, () => {
    db.prepare(
      `INSERT INTO work_items (id, title, status, priority, version, source, rounds, created_by, root_id, depth, created_at, updated_at)
       VALUES (?, 'seeded', 'backlog', 2, 1, 'human', 0, ?, ?, 0, ?, ?)`,
    ).run(claim.id, createdBy, claim.id, SEEDED_AT, SEEDED_AT);
  });
  return claim.id;
}

const keptIds = (db: import("better-sqlite3").Database): string[] =>
  db.prepare("SELECT work_item_id FROM work_item_kept ORDER BY work_item_id").pluck().all() as string[];

/* Keeping lands in a new table, never a column: `verifyCurrentWorkItemSchema`
 * compares every stored table DDL byte-for-byte, so a column on `work_items`
 * would make every deployed database refuse to boot. */
describe("work_item_kept is additive", () => {
  it("is created on a fresh database at its frozen shape, and verifies", () => {
    const { db } = freshDatabase("fresh.db");
    expect(shape(storedSql(db, "work_item_kept"))).toBe(shape(WORK_ITEM_KEPT_DDL));
    expect(() => migrate.verifyCurrentWorkItemSchema(db)).not.toThrow();
    db.close();
  });

  it("heals a database that predates the table: classified current, table gained, work_items untouched", () => {
    const { file, db } = freshDatabase("heal.db");
    db.exec("DROP TABLE work_item_kept");
    const workItemsBefore = storedSql(db, "work_items");
    expect(() => migrate.verifyCurrentWorkItemSchema(db)).toThrow(migrate.UNSUPPORTED_PRERELEASE_TODO_DATA);
    db.close();

    expect(migrate.preflightWorkItemsDatabase(file)).toBe("current");

    const healed = new Database(file);
    expect(migrate.migrateWorkItemsSchema(healed, "current").rebuilt).toBe(false);
    expect(storedSql(healed, "work_item_kept")).toBeTypeOf("string");
    expect(storedSql(healed, "work_items")).toBe(workItemsBefore);
    expect(() => migrate.verifyCurrentWorkItemSchema(healed)).not.toThrow();
    healed.close();
  });

  it("refuses at preflight when the table is present at a different shape", () => {
    const { file, db } = freshDatabase("drift.db");
    db.exec("DROP TABLE work_item_kept");
    db.exec("CREATE TABLE work_item_kept (work_item_id TEXT PRIMARY KEY)");
    db.close();
    expect(() => migrate.preflightWorkItemsDatabase(file)).toThrow(migrate.UNSUPPORTED_PRERELEASE_TODO_DATA);
  });
});

/* Auto-keep on create, plus the keep backfill of every
 * `created_by = 'operator'` row, filled Home with everything an agent had ever
 * minted with the operator's credential. Both are gone; the rows they wrote are
 * cleared once, on the first boot that carries this change. */

/** A database as it stood before this change: kept rows, and no marker saying
 *  they have been dealt with. `meta` is the sessions schema's, so a work-items
 *  fixture has to stand it up itself. */
function pollutedDatabase(name: string): { file: string; id: string } {
  const { file, db } = freshDatabase(name);
  const id = seed(db, "operator");
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
  db.prepare("INSERT INTO work_item_kept (work_item_id, kept_at) VALUES (?, ?)").run(id, SEEDED_AT);
  db.exec("DELETE FROM meta");
  db.close();
  return { file, id };
}

function boot(file: string): import("better-sqlite3").Database {
  const db = new Database(file);
  migrate.migrateWorkItemsSchema(db, "current");
  return db;
}

describe("the upgrade clears the kept set auto-keep filled", () => {
  it("empties a populated work_item_kept on the first boot after the change", () => {
    const { file } = pollutedDatabase("polluted.db");

    const upgraded = boot(file);
    expect(keptIds(upgraded)).toEqual([]);
    upgraded.close();
  });

  it("leaves a pin made after that boot alone on the next one", () => {
    const { file, id } = pollutedDatabase("repin.db");

    const upgraded = boot(file);
    upgraded.prepare("INSERT INTO work_item_kept (work_item_id, kept_at) VALUES (?, ?)").run(id, SEEDED_AT);
    upgraded.close();

    const rebooted = boot(file);
    expect(keptIds(rebooted)).toEqual([id]);
    rebooted.close();
  });

  it("keeps a fresh database's first pin, having nothing to clear", () => {
    const { file, db } = freshDatabase("fresh-pin.db");
    const id = seed(db, "operator");
    expect(keptIds(db)).toEqual([]);
    db.prepare("INSERT INTO work_item_kept (work_item_id, kept_at) VALUES (?, ?)").run(id, SEEDED_AT);
    db.close();

    const rebooted = boot(file);
    expect(keptIds(rebooted)).toEqual([id]);
    rebooted.close();
  });
});
