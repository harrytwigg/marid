import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Throwaway DB before importing the registry (SESSIONS_DB resolves from JINN_HOME).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-engine-spend-"));
process.env.JINN_HOME = tmp;
const dbModule = await import("../../shared/db.js");

type Reg = typeof import("../registry.js");
type Spend = typeof import("../engine-spend.js");
let reg: Reg;
let spend: Spend;

beforeAll(async () => {
  reg = await import("../registry.js");
  spend = await import("../engine-spend.js");
});

function seed(id: string, engine: string, model: string | null): void {
  dbModule.initDb().prepare(
    "INSERT INTO sessions (id, engine, model, source, source_ref, status, created_at, last_activity) VALUES (?, ?, ?, 'web', ?, 'idle', '2026-09-24T00:00:00Z', '2026-09-24T00:00:00Z')",
  ).run(id, engine, model, `web:${id}`);
}

/**
 * a windowed allowance can only be metered from spend that carries a
 * timestamp, and `sessions.total_cost` is a running total. These pin the
 * ledger's contract: every costed turn is a row, attributed to the engine and
 * model the session row names when the turn settles.
 */
describe("engine_spend ledger", () => {
  it("records a costed turn against the session's engine and model", () => {
    seed("oc-1", "opencode", "opencode-go/deepseek-v4.1-flash");
    const before = Date.now();
    reg.recordTurnAccounting("oc-1", { cost: 0.002, numTurns: 3 });
    const rows = spend.readEngineSpend(dbModule.initDb(), "opencode", before - 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ model: "opencode-go/deepseek-v4.1-flash", cost: 0.002 });
    expect(rows[0].atMs).toBeGreaterThanOrEqual(before);
  });

  it("names the model the turn ran on, which an unpinned session's row cannot", () => {
    seed("oc-ran", "opencode", null);
    reg.recordTurnAccounting("oc-ran", { cost: 0.4, numTurns: 1, model: "opencode-go/deepseek-v4.1-flash" });
    seed("oc-pin", "opencode", "opencode-go/pinned");
    reg.recordTurnAccounting("oc-pin", { cost: 0.4, numTurns: 1, model: "opencode-go/ran-instead" });
    const model = (id: string) => (dbModule.initDb().prepare("SELECT model FROM engine_spend WHERE session_id = ?").get(id) as { model: string | null }).model;
    expect(model("oc-ran")).toBe("opencode-go/deepseek-v4.1-flash");
    expect(model("oc-pin")).toBe("opencode-go/ran-instead");
  });

  it("keeps the session's running total in step with the ledger", () => {
    seed("oc-2", "opencode", null);
    reg.recordTurnAccounting("oc-2", { cost: 0.01, numTurns: 1 });
    reg.recordTurnAccounting("oc-2", { cost: 0.02, numTurns: 1 });
    const total = dbModule.initDb().prepare("SELECT total_cost FROM sessions WHERE id = ?").get("oc-2") as { total_cost: number };
    const ledger = dbModule.initDb()
      .prepare("SELECT SUM(cost) AS cost, COUNT(*) AS n, MAX(model) AS model FROM engine_spend WHERE session_id = ?")
      .get("oc-2") as { cost: number; n: number; model: string | null };
    expect(ledger.n).toBe(2);
    expect(ledger.cost).toBeCloseTo(total.total_cost, 10);
    expect(ledger.model).toBeNull(); // unpinned: the meter charges it to the engine default
  });

  it("does not record a turn that cost nothing", () => {
    seed("oc-3", "opencode", "m");
    reg.recordTurnAccounting("oc-3", { numTurns: 1 });
    reg.recordTurnAccounting("oc-3", { cost: 0, numTurns: 1 });
    const n = dbModule.initDb().prepare("SELECT COUNT(*) AS n FROM engine_spend WHERE session_id = ?").get("oc-3") as { n: number };
    expect(n.n).toBe(0);
  });

  it("charges a substituted turn to the engine that ran it, not the one the session started on", () => {
    // A rate-limit substitution rewrites engine and model on the row before the
    // turn settles; the ledger reads the row at that moment.
    seed("cl-1", "claude", "opus");
    dbModule.initDb().prepare("UPDATE sessions SET engine = 'opencode', model = 'opencode-go/deepseek-v4.1-flash' WHERE id = ?").run("cl-1");
    reg.recordTurnAccounting("cl-1", { cost: 0.5, numTurns: 1 });
    const row = dbModule.initDb().prepare("SELECT engine, model FROM engine_spend WHERE session_id = ?").get("cl-1");
    expect(row).toEqual({ engine: "opencode", model: "opencode-go/deepseek-v4.1-flash" });
  });

  it("outlives the session it was spent by", () => {
    seed("oc-4", "opencode", "m");
    reg.recordTurnAccounting("oc-4", { cost: 1, numTurns: 1 });
    dbModule.initDb().prepare("DELETE FROM sessions WHERE id = ?").run("oc-4");
    const n = dbModule.initDb().prepare("SELECT COUNT(*) AS n FROM engine_spend WHERE session_id = ?").get("oc-4") as { n: number };
    expect(n.n).toBe(1);
  });

  it("prunes rows older than the retention on a later write", () => {
    const db = dbModule.initDb();
    seed("oc-5", "opencode", "m");
    const now = Date.now();
    db.prepare("INSERT INTO engine_spend (session_id, engine, model, cost, at_ms) VALUES ('oc-5', 'opencode', 'm', 9, ?)")
      .run(now - spend.ENGINE_SPEND_RETENTION_MS - 1);
    spend.__resetEngineSpendPruneForTest();
    spend.recordEngineSpend(db, "oc-5", 0.1, now);
    const costs = (db.prepare("SELECT cost FROM engine_spend WHERE session_id = 'oc-5'").all() as Array<{ cost: number }>).map((r) => r.cost);
    expect(costs).toEqual([0.1]);
  });

  it("reads one engine's rows only, oldest first, strictly after the bound", () => {
    const db = dbModule.initDb();
    seed("px-1", "pi", "m");
    seed("oc-6", "opencode", "m");
    db.prepare("DELETE FROM engine_spend").run();
    db.prepare("INSERT INTO engine_spend (session_id, engine, model, cost, at_ms) VALUES ('oc-6','opencode','m',2,200),('oc-6','opencode','m',1,100),('px-1','pi','m',5,150),('oc-6','opencode','m',3,50)").run();
    expect(spend.readEngineSpend(db, "opencode", 50).map((r) => r.cost)).toEqual([1, 2]);
  });
});
