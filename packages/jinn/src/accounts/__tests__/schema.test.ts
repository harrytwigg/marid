import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { ACCOUNT_TABLES } from "../schema.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-accounts-schema-"));
process.env.JINN_HOME = tmp;

type Migrate = typeof import("../../work-items/migrate.js");
let migrate: Migrate;
beforeAll(async () => { migrate = await import("../../work-items/migrate.js"); });
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const shape = (sql: string | undefined) =>
  (sql ?? "").replace(/\bIF\s+NOT\s+EXISTS\b/gi, "").replace(/\s+/g, " ").replace(/;\s*$/, "").trim().toLowerCase();
const storedSql = (db: import("better-sqlite3").Database, table: string) =>
  (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string } | undefined)?.sql;

function freshDatabase(name: string) {
  const file = path.join(tmp, name);
  const db = new Database(file);
  migrate.migrateWorkItemsSchema(db, "absent");
  return { file, db };
}

describe("account tables are additive and shape-verified at boot", () => {
  it("creates all five at their frozen shape on a fresh database, and the verifier accepts them", () => {
    const { db } = freshDatabase("fresh.db");
    for (const table of ACCOUNT_TABLES) expect(shape(storedSql(db, table.name))).toBe(shape(table.tableDdl));
    expect(() => migrate.verifyCurrentWorkItemSchema(db)).not.toThrow();
    db.close();
  });

  it("heals a database that predates them: classified current, tables gained, work_items untouched", () => {
    const { file, db } = freshDatabase("heal.db");
    for (const name of ["user_sessions", "board_members", "user_tokens", "login_attempts", "users"]) db.exec(`DROP TABLE ${name}`);
    const workItemsBefore = storedSql(db, "work_items");
    db.close();

    expect(migrate.preflightWorkItemsDatabase(file)).toBe("current");
    const healed = new Database(file);
    expect(migrate.migrateWorkItemsSchema(healed, "current").rebuilt).toBe(false);
    for (const table of ACCOUNT_TABLES) expect(storedSql(healed, table.name)).toBeTypeOf("string");
    expect(storedSql(healed, "work_items")).toBe(workItemsBefore);
    expect(() => migrate.verifyCurrentWorkItemSchema(healed)).not.toThrow();
    healed.close();
  });

  it("refuses at preflight when one is present at a different shape", () => {
    const { file, db } = freshDatabase("drift.db");
    db.exec("DROP TABLE login_attempts");
    db.exec("CREATE TABLE login_attempts (email_or_ip TEXT)");
    db.close();
    expect(() => migrate.preflightWorkItemsDatabase(file)).toThrow(migrate.UNSUPPORTED_PRERELEASE_TODO_DATA);
  });

  it("enforces the role, status and purpose checks and the unique, case-insensitive email", () => {
    const { db } = freshDatabase("checks.db");
    const insert = (email: string, extra = "'member'") => db.prepare(
      `INSERT INTO users (id, email, display_name, instance_role, created_at, created_by, updated_at) VALUES (?, ?, 'N', ${extra}, 't', 'operator', 't')`,
    ).run(`usr_${email}`, email);
    insert("a@x.test");
    expect(() => insert("A@X.TEST")).toThrow(/UNIQUE/);
    expect(() => insert("b@x.test", "'root'")).toThrow(/CHECK/);
    expect(() => db.prepare("INSERT INTO board_members VALUES ('usr_a@x.test', 'ops', 'admin', 'operator', 't')").run()).toThrow(/CHECK/);
    expect(() => db.prepare("INSERT INTO user_tokens (id, token_hash, purpose, email, created_by, created_at, expires_at) VALUES ('utk_1', 'h', 'login', 'a@x.test', 'operator', 't', 't')").run()).toThrow(/CHECK/);
    db.close();
  });
});
