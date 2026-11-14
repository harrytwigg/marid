import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { WORK_ITEM_RECOVERY_DDL } from "../recovery.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-wi-recovery-schema-"));
process.env.HUNDREDFOLD_HOME = tmp;

type Migrate = typeof import("../migrate.js");
let migrate: Migrate;

beforeAll(async () => {
  migrate = await import("../migrate.js");
});

const shape = (sql: string | undefined) =>
  (sql ?? "").replace(/\bIF\s+NOT\s+EXISTS\b/gi, "").replace(/\s+/g, " ").replace(/;\s*$/, "").trim().toLowerCase();

function storedSql(db: import("better-sqlite3").Database, table: string): string | undefined {
  return (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string } | undefined)?.sql;
}

describe("work_item_recovery is additive", () => {
  it("is created on a fresh database at its frozen shape, and verifies", () => {
    const file = path.join(tmp, "fresh.db");
    const db = new Database(file);
    migrate.migrateWorkItemsSchema(db, "absent");
    expect(shape(storedSql(db, "work_item_recovery"))).toBe(shape(WORK_ITEM_RECOVERY_DDL));
    expect(() => migrate.verifyCurrentWorkItemSchema(db)).not.toThrow();
    db.close();
  });
});
