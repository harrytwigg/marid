import { beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { DEPARTMENT_SCOPES_TABLE_DDL } from "../department-scopes-schema.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-dept-scopes-"));
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

const storedSql = (db: import("better-sqlite3").Database, table: string) =>
  (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string } | undefined)?.sql;

/* Last good scopes live in a table of their own, never a column on `departments`: the
 * boot verifier compares every stored table byte for byte, so a column would make every
 * deployed database refuse to boot. */
describe("department_scopes is additive", () => {
  it("is created on a fresh database at its frozen shape, and verifies", () => {
    const { db } = freshDatabase("fresh.db");
    expect(shape(storedSql(db, "department_scopes"))).toBe(shape(DEPARTMENT_SCOPES_TABLE_DDL));
    expect(() => migrate.verifyCurrentWorkItemSchema(db)).not.toThrow();
    db.close();
  });

  it("accepts the three scopes and nothing else", () => {
    const { db } = freshDatabase("check.db");
    const insert = db.prepare("INSERT INTO department_scopes (slug, scope, recorded_at) VALUES (?, ?, ?)");
    for (const scope of ["open", "scoped", "dedicated"]) expect(() => insert.run(`d-${scope}`, scope, "2026-10-06T00:00:00.000Z")).not.toThrow();
    expect(() => insert.run("d-bad", "sealed", "2026-10-06T00:00:00.000Z")).toThrow(/CHECK/);
    db.close();
  });

  it("heals a database that predates the table: classified current, table gained, departments untouched", () => {
    const { file, db } = freshDatabase("heal.db");
    db.exec("DROP TABLE department_scopes");
    const departmentsBefore = storedSql(db, "departments");
    expect(() => migrate.verifyCurrentWorkItemSchema(db)).toThrow(migrate.UNSUPPORTED_PRERELEASE_TODO_DATA);
    db.close();

    expect(migrate.preflightWorkItemsDatabase(file)).toBe("current");

    const healed = new Database(file);
    expect(migrate.migrateWorkItemsSchema(healed, "current").rebuilt).toBe(false);
    expect(storedSql(healed, "department_scopes")).toBeTypeOf("string");
    expect(storedSql(healed, "departments")).toBe(departmentsBefore);
    expect(() => migrate.verifyCurrentWorkItemSchema(healed)).not.toThrow();
    healed.close();
  });

  it("refuses at preflight when the table is present at a different shape", () => {
    const { file, db } = freshDatabase("drift.db");
    db.exec("DROP TABLE department_scopes");
    db.exec("CREATE TABLE department_scopes (slug TEXT PRIMARY KEY)");
    db.close();
    expect(() => migrate.preflightWorkItemsDatabase(file)).toThrow(migrate.UNSUPPORTED_PRERELEASE_TODO_DATA);
  });
});
