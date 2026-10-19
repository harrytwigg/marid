import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  WORK_ITEM_CREATE_RECEIPTS_TABLE_DDL,
  WORK_ITEM_DISPATCH_TABLE_DDL,
} from "../dispatch-schema.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-dispatch-schema-"));
process.env.JINN_HOME = tmp;

type Migrate = typeof import("../migrate.js");
let migrate: Migrate;

beforeAll(async () => {
  migrate = await import("../migrate.js");
});

const NEW_TABLES = ["work_item_dispatch", "work_item_create_receipts"] as const;

/**
 * `work_items` exactly as it stood BEFORE the dispatch-config table, frozen here on purpose.
 * `verifyCurrentWorkItemSchema` compares the stored DDL byte-for-byte, so a
 * column added to that table would make every deployed database refuse to boot
 * — this test is the tripwire for that, not documentation of it.
 */
const WORK_ITEMS_TABLE_DDL_BEFORE_DISPATCH_CONFIG = `
CREATE TABLE IF NOT EXISTS work_items (
  id                  TEXT PRIMARY KEY CHECK (
  id GLOB '[A-Z][A-Z][A-Z]-[1-9]*'
  AND substr(id, 5) NOT GLOB '*[^0-9]*'
  AND CAST(substr(id, 5) AS INTEGER) BETWEEN 1 AND 9007199254740991
  AND printf('%lld', CAST(substr(id, 5) AS INTEGER)) = substr(id, 5)
),
  title               TEXT NOT NULL,
  body                TEXT,
  status              TEXT NOT NULL DEFAULT 'backlog' CHECK (status IN ('backlog','assigned','executing','in_review','done','blocked','escalated','cancelled')),
  department          TEXT,
  assignee            TEXT,
  created_by          TEXT NOT NULL,
  parent_id           TEXT REFERENCES work_items(id),
  root_id             TEXT NOT NULL,
  depth               INTEGER NOT NULL DEFAULT 0 CHECK ((parent_id IS NULL AND depth = 0) OR (parent_id IS NOT NULL AND depth BETWEEN 1 AND 3)),
  due_at              TEXT,
  priority            INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 3),
  rank                REAL,
  version             INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  source              TEXT NOT NULL DEFAULT 'human' CHECK (source IN ('human','delegation','cron','workflow','session','connector','goal')),
  source_ref          TEXT,
  acceptance          TEXT,
  verify_policy       TEXT,
  rounds              INTEGER NOT NULL DEFAULT 0,
  budget_usd          REAL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  closed_at           TEXT
)`;

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

describe("the dispatch-config tables are additive", () => {
  it("creates both on a fresh database with their frozen DDL, and verifies", () => {
    const { db } = freshDatabase("fresh.db");
    expect(shape(storedSql(db, "work_item_dispatch"))).toBe(shape(WORK_ITEM_DISPATCH_TABLE_DDL));
    expect(shape(storedSql(db, "work_item_create_receipts"))).toBe(shape(WORK_ITEM_CREATE_RECEIPTS_TABLE_DDL));
    expect(() => migrate.verifyCurrentWorkItemSchema(db)).not.toThrow();
    db.close();
  });

  it("heals a database at the pre-change shape: classified current, both tables gained, no rebuild", () => {
    const { file, db } = freshDatabase("heal.db");
    for (const table of NEW_TABLES) db.exec(`DROP TABLE ${table}`);
    const workItemsBefore = storedSql(db, "work_items");
    expect(() => migrate.verifyCurrentWorkItemSchema(db)).toThrow(migrate.UNSUPPORTED_PRERELEASE_TODO_DATA);
    db.close();

    expect(migrate.preflightWorkItemsDatabase(file)).toBe("current");

    const healed = new Database(file);
    expect(migrate.migrateWorkItemsSchema(healed, "current").rebuilt).toBe(false);
    for (const table of NEW_TABLES) expect(storedSql(healed, table)).toBeTypeOf("string");
    // The heal adds tables and rewrites nothing: `work_items` comes out of it
    // byte-identical, which is what makes this a heal and not a rebuild.
    expect(storedSql(healed, "work_items")).toBe(workItemsBefore);
    expect(() => migrate.verifyCurrentWorkItemSchema(healed)).not.toThrow();
    healed.close();
  });

  it("refuses at preflight when one of them is present at a different shape", () => {
    const { file, db } = freshDatabase("drift.db");
    db.exec("DROP TABLE work_item_dispatch");
    db.exec("CREATE TABLE work_item_dispatch (work_item_id TEXT PRIMARY KEY, skills TEXT)");
    db.close();
    expect(() => migrate.preflightWorkItemsDatabase(file)).toThrow(migrate.UNSUPPORTED_PRERELEASE_TODO_DATA);
  });
});

describe("work_items itself is untouched by the dispatch-config tables", () => {
  it("still matches the shape it had before, so an existing database still verifies", () => {
    const { db } = freshDatabase("work-items-shape.db");
    expect(shape(storedSql(db, "work_items"))).toBe(shape(WORK_ITEMS_TABLE_DDL_BEFORE_DISPATCH_CONFIG));
    db.close();
  });

});

/** The foreign keys stop the honest write path; these prove the boot verifier
 *  re-checks the rows for a database that reached the state some other way. */
describe("the boot verifier re-proves the rows, not just the shapes", () => {
  it("refuses a dispatch row pointing at a Todo that does not exist", () => {
    const { db } = freshDatabase("dangling-dispatch.db");
    db.pragma("foreign_keys = OFF");
    db.prepare("INSERT INTO work_item_dispatch (work_item_id, updated_at) VALUES ('JIN-404', '2026-08-13T00:00:00.000Z')").run();
    expect(() => migrate.verifyCurrentWorkItemSchema(db)).toThrow(migrate.UNSUPPORTED_PRERELEASE_TODO_DATA);
    db.close();
  });

  it("refuses a dispatch row whose stored skills blob is not a list of names", () => {
    const { db } = freshDatabase("bad-skills-blob.db");
    const id = seedTodo(db);
    db.prepare("INSERT INTO work_item_dispatch (work_item_id, skills, updated_at) VALUES (?, '{\"not\":\"a list\"}', '2026-08-13T00:00:00.000Z')").run(id);
    expect(() => migrate.verifyCurrentWorkItemSchema(db)).toThrow(migrate.UNSUPPORTED_PRERELEASE_TODO_DATA);
    db.close();
  });

  it("refuses a create receipt whose Todo is gone, so a replay can never resolve to nothing", () => {
    const { db } = freshDatabase("dangling-receipt.db");
    db.pragma("foreign_keys = OFF");
    db.prepare(
      `INSERT INTO work_item_create_receipts (key_digest, work_item_id, fingerprint, created_at)
       VALUES (?, 'JIN-404', 'f', '2026-08-13T00:00:00.000Z')`,
    ).run("a".repeat(64));
    expect(() => migrate.verifyCurrentWorkItemSchema(db)).toThrow(migrate.UNSUPPORTED_PRERELEASE_TODO_DATA);
    db.close();
  });
});

/** One real Todo through the allocator, so the row references something live. */
function seedTodo(db: import("better-sqlite3").Database): string {
  migrate.registerWorkItemIdentityFunctions(db);
  const now = "2026-08-13T00:00:00.000Z";
  const claim = migrate.allocateWorkItemId(db, now, "JIN");
  migrate.useWorkItemAllocationClaim(db, claim, () => {
    db.prepare(
      `INSERT INTO work_items (id, title, status, priority, version, source, rounds, created_by, root_id, depth, created_at, updated_at)
       VALUES (?, 'carrier', 'backlog', 2, 1, 'human', 0, 'operator', ?, 0, ?, ?)`,
    ).run(claim.id, claim.id, now, now);
  });
  return claim.id;
}
