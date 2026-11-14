import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureAccountTables } from "../schema.js";
import { INSTANCE_KEY, RECENT_SUCCESS_MS, checkInstanceBudget, recordSuccess, reserveAttempt } from "../login-attempts.js";
import { isoNow } from "../ids.js";

let db: Database.Database;
beforeEach(() => { db = new Database(":memory:"); ensureAccountTables(db); });
afterEach(() => db.close());

const HOUR = 60 * 60 * 1000;
const keys = () => (db.prepare("SELECT email_or_ip AS k FROM login_attempts ORDER BY k").all() as Array<{ k: string }>).map((r) => r.k);
const put = (key: string, at: number) => db.prepare("INSERT INTO login_attempts (email_or_ip, at) VALUES (?, ?)").run(key, isoNow(at));

describe("pruning", () => {
  it("drops attempts after an hour but keeps `ok:` rows for 30 days", () => {
    const now = Date.parse("2026-06-01T00:00:00Z");
    put("email:old@example.test", now - 2 * HOUR);
    put("ip:198.51.100.1", now - 2 * HOUR);
    put(INSTANCE_KEY, now - 2 * HOUR);
    put("email:fresh@example.test", now - HOUR / 2);
    put("ok:198.51.100.2", now - 20 * 24 * HOUR);
    put("ok:198.51.100.3", now - RECENT_SUCCESS_MS - 1000);
    reserveAttempt(db, { ip: undefined, email: "x@example.test" }, now);
    expect(keys()).toEqual(["email:fresh@example.test", "email:x@example.test", "ok:198.51.100.2"]);
  });

  it("uses the (key, at) index for each prune delete", () => {
    const plan = (sql: string, ...args: unknown[]) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>).map((r) => r.detail).join(" | ");
    expect(plan("DELETE FROM login_attempts WHERE email_or_ip >= ? AND email_or_ip < ? AND at <= ?", "ok:", "ok;", "x")).toContain("idx_login_attempts_key");
    expect(plan("DELETE FROM login_attempts WHERE (email_or_ip < ? OR email_or_ip >= ?) AND at <= ?", "ok:", "ok;", "x")).toContain("idx_login_attempts_key");
  });
});

describe("recordSuccess", () => {
  it("keeps one row per address, renewed by each success", () => {
    const now = Date.now();
    recordSuccess(db, "198.51.100.1", now);
    recordSuccess(db, "198.51.100.1", now + 1000);
    recordSuccess(db, "198.51.100.2", now);
    expect(keys()).toEqual(["ok:198.51.100.1", "ok:198.51.100.2"]);
  });
});

describe("checkInstanceBudget", () => {
  it("allows under the budget, refuses at it, and exempts only an address with a success", () => {
    const now = Date.now();
    for (let i = 0; i < 4; i++) reserveAttempt(db, { ip: undefined, instance: true }, now);
    expect(checkInstanceBudget(db, { address: undefined, max: 5 }, now).allowed).toBe(true);
    reserveAttempt(db, { ip: undefined, instance: true }, now);
    expect(checkInstanceBudget(db, { address: undefined, max: 5 }, now)).toMatchObject({ allowed: false, retryAfterSeconds: 900 });
    expect(checkInstanceBudget(db, { address: "198.51.100.1", max: 5 }, now).allowed).toBe(false);
    recordSuccess(db, "198.51.100.1", now - 1000);
    expect(checkInstanceBudget(db, { address: "198.51.100.1", max: 5 }, now)).toMatchObject({ allowed: true });
    expect(checkInstanceBudget(db, { address: "198.51.100.2", max: 5 }, now).allowed).toBe(false);
  });
});
