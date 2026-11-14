/** Stored DDL, normalized for comparison against a canonical constant: SQLite
 *  keeps the CREATE statement it was given, so `IF NOT EXISTS`, whitespace, a
 *  trailing semicolon and case are noise rather than shape. Shared by the boot
 *  verifier and by the run ledger's own schema history, which both decide
 *  whether a deployed table is a shape they recognize. */
export function sqlShape(sql: string | null | undefined): string {
  return (sql ?? "")
    .replace(/\bIF\s+NOT\s+EXISTS\b/gi, "")
    .replace(/\s+/g, " ")
    .replace(/;\s*$/, "")
    .trim()
    .toLowerCase();
}

/** The stored CREATE statement of a table, or undefined when it is absent. */
export function currentTableSql(db: import("better-sqlite3").Database, name: string): string | undefined {
  return (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as
    { sql: string } | undefined)?.sql;
}
