import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { WORK_ITEM_BLOCKS_DDL } from "../blocks.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-wi-blocks-schema-"));
process.env.HUNDREDFOLD_HOME = tmp;

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

const shape = (sql: string) => sql.replace(/\bIF\s+NOT\s+EXISTS\b/gi, "").replace(/\s+/g, " ").trim().toLowerCase();

describe("work_item_blocks in the frozen schema", () => {
  it("is created on a fresh database with the exact frozen DDL and verifies", () => {
    const { db } = freshDatabase("fresh.db");
    const stored = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'work_item_blocks'")
      .get() as { sql: string }).sql;
    expect(shape(stored)).toBe(shape(WORK_ITEM_BLOCKS_DDL));
    expect(() => migrate.verifyCurrentWorkItemSchema(db)).not.toThrow();
    db.close();
  });

  // The reason the counter is a table and not a column: `work_items` is verified
  // by exact-shape compare, so a column on it would refuse every deployed boot.
  it("keeps the block state off work_items — no column of its own", () => {
    const { db } = freshDatabase("work-items-shape.db");
    const columns = (db.prepare("PRAGMA table_info(work_items)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns.filter((name) => name.startsWith("block"))).toEqual([]);
    db.close();
  });

  it("heals a v2 database that predates the table, and still verifies", () => {
    const { file, db } = freshDatabase("heal.db");
    db.exec("DROP TABLE work_item_blocks");
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
    db.exec("DROP TABLE work_item_blocks");
    db.exec("CREATE TABLE work_item_blocks (work_item_id TEXT PRIMARY KEY, kind TEXT)");
    db.close();
    expect(() => migrate.preflightWorkItemsDatabase(file)).toThrow(migrate.UNSUPPORTED_PRERELEASE_TODO_DATA);
  });

  it("refuses a kind outside the four the router knows, and a negative count", () => {
    const { db } = freshDatabase("bad-kind.db");
    const insert = (kind: string, recurrences: number) =>
      db.prepare(
        `INSERT INTO work_item_blocks (work_item_id, kind, recurrences, first_blocked_at, last_blocked_at)
         VALUES ('JIN-1', ?, ?, '2026-08-13T00:00:00.000Z', '2026-08-13T00:00:00.000Z')`,
      ).run(kind, recurrences);
    expect(() => insert("waiting", 0)).toThrow(/CHECK/i);
    expect(() => insert("dependency", -1)).toThrow(/CHECK/i);
    db.close();
  });
});
