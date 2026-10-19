import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-search-migrate-"));
process.env.JINN_HOME = tmp;

type Migrate = typeof import("../migrate.js");
type SearchIndex = typeof import("../search-index.js");
let migrate: Migrate;
let searchIndex: SearchIndex;

const SEEDED_AT = "2026-01-01T00:00:00.000Z";

beforeAll(async () => {
  migrate = await import("../migrate.js");
  searchIndex = await import("../search-index.js");
});

function seedTodo(db: Database.Database, title: string, body: string): string {
  const claim = migrate.allocateWorkItemId(db, SEEDED_AT, "JIN");
  migrate.useWorkItemAllocationClaim(db, claim, () => {
    db.prepare(
      `INSERT INTO work_items (id, title, body, created_by, root_id, depth, created_at, updated_at)
       VALUES (?, ?, ?, 'operator', ?, 0, ?, ?)`,
    ).run(claim.id, title, body, claim.id, SEEDED_AT, SEEDED_AT);
  });
  return claim.id;
}

function seedComment(db: Database.Database, workItemId: string, suffix: string, body: string): void {
  db.prepare(
    `INSERT INTO work_item_comments (id, work_item_id, author_kind, author, body, created_at)
     VALUES (?, ?, 'operator', 'operator', ?, ?)`,
  ).run(`wic_${suffix}`, workItemId, body, SEEDED_AT);
}

/** Rows the index itself can find. `COUNT(*)` on an external-content FTS5
 *  table would read the content table instead, and say nothing about the index. */
function indexed(db: Database.Database, table: string, term: string): number {
  return Number(db.prepare(`SELECT COUNT(*) FROM ${table} WHERE ${table} MATCH '"${term}"'`).pluck().get());
}

/** The real index bytes, not the content table read back through it. */
function indexBytes(db: Database.Database): string {
  return ["work_items_fts_data", "work_item_comments_fts_data"]
    .map((table) =>
      (db.prepare(`SELECT id, block FROM ${table} ORDER BY id`).all() as Array<{ id: number; block: Buffer | null }>)
        .map((row) => `${row.id}:${row.block ? row.block.toString("hex") : ""}`)
        .join("|"),
    )
    .join("||");
}

/** A v2 database as it stood before the search indexes: Todos and comments, no indexes. */
function preSearchIndexDatabase(name: string): { file: string; db: Database.Database } {
  const file = path.join(tmp, name);
  const db = new Database(file);
  migrate.migrateWorkItemsSchema(db, "absent");
  searchIndex.migrateWorkItemSearchIndex(db);
  for (const trigger of ["ai", "ad", "au"]) {
    db.exec(`DROP TRIGGER work_items_fts_${trigger}`);
    db.exec(`DROP TRIGGER work_item_comments_fts_${trigger}`);
  }
  db.exec("DROP TABLE work_items_fts");
  db.exec("DROP TABLE work_item_comments_fts");

  const first = seedTodo(db, "Redesign Todos Search", "Typing a query opens a preview pane.");
  const second = seedTodo(db, "Quarterly ledger chore", "Routine reconciliation.");
  seedComment(db, first, "0000000000a1", "Wave one is the server-side index.");
  seedComment(db, second, "0000000000a2", "The marmalade cascade needs a rethink.");
  return { file, db };
}

describe("search-index migration", () => {
  it("backfills both indexes for a database that already holds Todos and comments", () => {
    const { file, db } = preSearchIndexDatabase("backfill.db");
    expect(migrate.preflightWorkItemsDatabase(file)).toBe("current");

    migrate.migrateWorkItemsSchema(db);
    searchIndex.migrateWorkItemSearchIndex(db);

    expect(indexed(db, "work_items_fts", "preview")).toBe(1);
    expect(indexed(db, "work_items_fts", "reconciliation")).toBe(1);
    expect(indexed(db, "work_item_comments_fts", "marmalade")).toBe(1);
    expect(indexed(db, "work_item_comments_fts", "server")).toBe(1);
    expect(() => migrate.verifyCurrentWorkItemSchema(db)).not.toThrow();
    db.close();
  });

  it("leaves index content untouched on a second run", () => {
    const { db } = preSearchIndexDatabase("idempotent.db");
    migrate.migrateWorkItemsSchema(db);
    searchIndex.migrateWorkItemSearchIndex(db);
    const after = indexBytes(db);
    expect(after).not.toBe("||");

    expect(migrate.migrateWorkItemsSchema(db)).toEqual({ rebuilt: false, rows: 0 });
    searchIndex.migrateWorkItemSearchIndex(db);
    expect(indexBytes(db)).toBe(after);
    expect(() => migrate.verifyCurrentWorkItemSchema(db)).not.toThrow();
    db.close();
  });

  it("creates the indexes empty and trigger-fed on a fresh database", () => {
    const db = new Database(path.join(tmp, "fresh.db"));
    migrate.migrateWorkItemsSchema(db, "absent");
    searchIndex.migrateWorkItemSearchIndex(db);
    expect(indexed(db, "work_items_fts", "sheave")).toBe(0);

    const id = seedTodo(db, "Halyard audit", "Frayed at the sheave.");
    seedComment(db, id, "0000000000b1", "Replace before the crossing.");
    expect(indexed(db, "work_items_fts", "sheave")).toBe(1);
    expect(indexed(db, "work_item_comments_fts", "crossing")).toBe(1);
    db.close();
  });
});

describe("search-index drift", () => {
  // Both defects below are accepted by a name-only check: the first makes every
  // later query throw, the second silently loses whatever was written while the
  // trigger was gone. Neither is visible to the caller, so the migration has to
  // recognise the shape and rebuild from the content that is still intact.
  it("replaces an object of the right name but the wrong shape", () => {
    const { db } = preSearchIndexDatabase("wrong-shape.db");
    db.exec("CREATE TABLE work_items_fts (title TEXT, body TEXT)");

    searchIndex.migrateWorkItemSearchIndex(db);

    expect(indexed(db, "work_items_fts", "preview")).toBe(1);
    db.close();
  });

  it("reindexes an edit made while a trigger was missing", () => {
    const { db } = preSearchIndexDatabase("lost-trigger.db");
    searchIndex.migrateWorkItemSearchIndex(db);
    expect(indexed(db, "work_items_fts", "preview")).toBe(1);

    db.exec("DROP TRIGGER work_items_fts_au");
    db.prepare("UPDATE work_items SET body = 'Typing a query opens a lightbox.' WHERE body LIKE '%preview%'").run();
    expect(indexed(db, "work_items_fts", "lightbox")).toBe(0); // the edit went unseen

    searchIndex.migrateWorkItemSearchIndex(db);

    expect(indexed(db, "work_items_fts", "lightbox")).toBe(1);
    expect(indexed(db, "work_items_fts", "preview")).toBe(0);
    db.close();
  });
});
