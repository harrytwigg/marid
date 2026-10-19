import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { WORK_ITEM_STOP_CAUSE_DDL } from "../stop-cause.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-stop-cause-schema-"));
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

/* The stop cause lands in a new table, never a column: `verifyCurrentWorkItemSchema`
 * compares every stored table DDL byte-for-byte, so a column on `work_items`
 * would make every deployed database refuse to boot. */
describe("work_item_stop_cause is additive", () => {
  it("is created on a fresh database at its frozen shape, and verifies", () => {
    const { db } = freshDatabase("fresh.db");
    expect(shape(storedSql(db, "work_item_stop_cause"))).toBe(shape(WORK_ITEM_STOP_CAUSE_DDL));
    expect(() => migrate.verifyCurrentWorkItemSchema(db)).not.toThrow();
    db.close();
  });

  it("heals a database that predates the table: classified current, table gained, work_items untouched", () => {
    const { file, db } = freshDatabase("heal.db");
    db.exec("DROP TABLE work_item_stop_cause");
    const workItemsBefore = storedSql(db, "work_items");
    expect(() => migrate.verifyCurrentWorkItemSchema(db)).toThrow(migrate.UNSUPPORTED_PRERELEASE_TODO_DATA);
    db.close();

    expect(migrate.preflightWorkItemsDatabase(file)).toBe("current");

    const healed = new Database(file);
    expect(migrate.migrateWorkItemsSchema(healed, "current").rebuilt).toBe(false);
    expect(storedSql(healed, "work_item_stop_cause")).toBeTypeOf("string");
    // The heal adds a table and rewrites nothing: `work_items` comes out of it
    // byte-identical, which is what makes this a heal and not a rebuild.
    expect(storedSql(healed, "work_items")).toBe(workItemsBefore);
    expect(() => migrate.verifyCurrentWorkItemSchema(healed)).not.toThrow();
    healed.close();
  });

  it("refuses at preflight when the table is present at a different shape", () => {
    const { file, db } = freshDatabase("drift.db");
    db.exec("DROP TABLE work_item_stop_cause");
    db.exec("CREATE TABLE work_item_stop_cause (work_item_id TEXT PRIMARY KEY, parked_until TEXT)");
    db.close();
    expect(() => migrate.preflightWorkItemsDatabase(file)).toThrow(migrate.UNSUPPORTED_PRERELEASE_TODO_DATA);
  });
});
