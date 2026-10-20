import type { Database as DatabaseType } from "better-sqlite3";
import { sqlShape } from "./sql-shape.js";

/**
 * Full-text search index over Todos and their comments.
 *
 * Two external-content FTS5 tables, mirroring `messages_fts`
 * (`sessions/migrate.ts`): the index lives here and the text is read back from
 * `work_items` / `work_item_comments` by rowid, which is what lets `snippet()`
 * serve a per-row match reason. A contentless index could not.
 *
 * Currency is owned by SQL triggers, not by JS call sites — the store has three
 * distinct `UPDATE work_items SET` paths and comments mutate through insert,
 * edit, and tombstone — so every write moves the index inside the writer's own
 * transaction. There is no watermark machinery: `messages_fts` needs one only
 * because the message table is unbounded, while Todos and their comments number
 * in the thousands and seed synchronously.
 */

const WORK_ITEMS_FTS_STATEMENTS = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS work_items_fts USING fts5(title, body, content='work_items', content_rowid='rowid', tokenize='unicode61')`,
  `CREATE TRIGGER IF NOT EXISTS work_items_fts_ai AFTER INSERT ON work_items BEGIN
  INSERT INTO work_items_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END`,
  `CREATE TRIGGER IF NOT EXISTS work_items_fts_ad AFTER DELETE ON work_items BEGIN
  INSERT INTO work_items_fts(work_items_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
END`,
  `CREATE TRIGGER IF NOT EXISTS work_items_fts_au AFTER UPDATE ON work_items BEGIN
  INSERT INTO work_items_fts(work_items_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO work_items_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END`,
];

// A tombstone clears the comment body rather than deleting the row, so the AU
// trigger alone is what stops a deleted comment matching: it re-indexes ''.
const WORK_ITEM_COMMENTS_FTS_STATEMENTS = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS work_item_comments_fts USING fts5(body, content='work_item_comments', content_rowid='rowid', tokenize='unicode61')`,
  `CREATE TRIGGER IF NOT EXISTS work_item_comments_fts_ai AFTER INSERT ON work_item_comments BEGIN
  INSERT INTO work_item_comments_fts(rowid, body) VALUES (new.rowid, new.body);
END`,
  `CREATE TRIGGER IF NOT EXISTS work_item_comments_fts_ad AFTER DELETE ON work_item_comments BEGIN
  INSERT INTO work_item_comments_fts(work_item_comments_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
END`,
  `CREATE TRIGGER IF NOT EXISTS work_item_comments_fts_au AFTER UPDATE ON work_item_comments BEGIN
  INSERT INTO work_item_comments_fts(work_item_comments_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
  INSERT INTO work_item_comments_fts(rowid, body) VALUES (new.rowid, new.body);
END`,
];

const SEARCH_INDEXES: ReadonlyArray<{ table: string; statements: readonly string[] }> = [
  { table: "work_items_fts", statements: WORK_ITEMS_FTS_STATEMENTS },
  { table: "work_item_comments_fts", statements: WORK_ITEM_COMMENTS_FTS_STATEMENTS },
];

/** The object a canonical statement creates: `CREATE VIRTUAL TABLE x` / `CREATE TRIGGER x`. */
function declaredObject(statement: string): { type: "table" | "trigger"; name: string } {
  const match = /^CREATE\s+(VIRTUAL\s+TABLE|TRIGGER)\s+(?:IF\s+NOT\s+EXISTS\s+)?(\S+)/i.exec(statement);
  if (!match) throw new Error(`unrecognized search-index statement: ${statement.slice(0, 40)}`);
  return { type: /TABLE/i.test(match[1]) ? "table" : "trigger", name: match[2] };
}

function storedSql(db: DatabaseType, type: string, name: string): string | undefined {
  return (db.prepare("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?").get(type, name) as
    { sql: string } | undefined)?.sql;
}

/**
 * Bring both indexes to their canonical shape, then reseed whichever one moved.
 *
 * Each object is checked by its STORED DDL, not by its name. A name-only check
 * accepts an `work_items_fts` that is an ordinary table (every later query then
 * fails with `no such column`) and accepts a missing or edited trigger (every
 * write made while it was gone stays unindexed, silently and permanently). Both
 * are corrected here rather than refused at boot, because unlike the ledger
 * tables this index carries no data of its own: it is derived from
 * `work_items` / `work_item_comments`, so the honest response to drift is to
 * rebuild it from the content that is still intact.
 *
 * `rebuild` is FTS5 reseeding itself from that content, so it is idempotent: a
 * migration that finds every shape already canonical rebuilds nothing and
 * leaves index content byte-identical, which keeps boot off a full reindex.
 */
export function migrateWorkItemSearchIndex(db: DatabaseType): void {
  for (const { table, statements } of SEARCH_INDEXES) {
    let repaired = false;
    for (const statement of statements) {
      const { type, name } = declaredObject(statement);
      if (sqlShape(storedSql(db, type, name)) === sqlShape(statement)) continue;
      db.exec(`DROP ${type === "table" ? "TABLE" : "TRIGGER"} IF EXISTS ${name}`);
      db.exec(statement);
      repaired = true;
    }
    if (repaired) db.exec(`INSERT INTO ${table}(${table}) VALUES ('rebuild')`);
  }
}
