import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { useTempHome } from "./db-fixtures.js";

useTempHome("jinn-board-hooks-runs-");

type Runs = typeof import("../run-store.js");
type Db = ReturnType<typeof import("../../shared/db.js").initDb>;
let runs: Runs;
let db: Db;

beforeAll(async () => {
  runs = await import("../run-store.js");
  db = (await import("../../shared/db.js")).initDb();
});

beforeEach(() => {
  db.prepare("DELETE FROM board_hook_runs").run();
  runs.__resetBoardHookPruneForTest();
});

const base = { fireId: "bhf_1", hook: "h", event: "todo.created", eventId: "wie_1", todoId: "TSK-1", action: "spawn" as const, payload: { a: 1 }, chain: ["h"] };

describe("board_hook_runs", () => {
  it("records a running row and finishes it with the outcome", () => {
    const id = runs.insertRun({ ...base, status: "running" });
    expect(id).toMatch(/^bhr_[0-9a-f]{12}$/);
    expect(runs.getRun(id)).toMatchObject({ status: "running", finishedAt: null, sessionId: null, payload: { a: 1 }, chain: ["h"] });
    expect(runs.finishRun(id, { status: "ok", sessionId: "s-1" })).toBe("ok");
    expect(runs.getRun(id)).toMatchObject({ status: "ok", sessionId: "s-1", error: null });
    expect(runs.getRun(id)!.finishedAt).not.toBeNull();
  });

  it("leaves a row alone once it is no longer running", () => {
    const id = runs.insertRun({ ...base, status: "running" });
    runs.finishRun(id, { status: "error", error: "first", exitCode: 1, output: "tail" });
    expect(runs.finishRun(id, { status: "ok" })).toBeUndefined();
    expect(runs.getRun(id)).toMatchObject({ status: "error", error: "first", exitCode: 1, output: "tail" });
  });

  it("stores a suppressed row as finished, with its reason", () => {
    const id = runs.insertRun({ ...base, action: "none", status: "suppressed", error: "already in the chain" });
    expect(runs.getRun(id)).toMatchObject({ action: "none", status: "suppressed", error: "already in the chain" });
    expect(runs.getRun(id)!.finishedAt).not.toBeNull();
  });

  it("marks leftover running rows interrupted at boot, and only those", () => {
    const stuck = runs.insertRun({ ...base, status: "running" });
    const done = runs.insertRun({ ...base, status: "running" });
    runs.finishRun(done, { status: "ok" });
    expect(runs.interruptLeftoverRuns()).toBe(1);
    expect(runs.getRun(stuck)).toMatchObject({ status: "interrupted" });
    expect(runs.getRun(stuck)!.error).toMatch(/gateway stopped/);
    expect(runs.getRun(stuck)!.finishedAt).not.toBeNull();
    expect(runs.getRun(done)!.status).toBe("ok");
  });

  it("lists newest first with filters and a cursor, without payload or output", () => {
    const t0 = Date.now() - 10_000;
    const ids = [0, 1, 2, 3, 4].map((n) => runs.insertRun({ ...base, hook: n % 2 ? "odd" : "even", todoId: n < 3 ? "TSK-1" : "TSK-2", status: "running" }, t0 + n * 1000));
    runs.finishRun(ids[0], { status: "error", error: "boom" });
    const all = runs.listRuns({});
    expect(all.runs.map((run) => run.id)).toEqual([...ids].reverse());
    expect(all.nextBefore).toBeNull();
    expect(all.runs[0]).not.toHaveProperty("payload");
    expect(all.runs[0]).not.toHaveProperty("output");
    expect(runs.listRuns({ hook: "odd" }).runs).toHaveLength(2);
    expect(runs.listRuns({ todo: "TSK-2" }).runs).toHaveLength(2);
    expect(runs.listRuns({ status: "error" }).runs.map((run) => run.id)).toEqual([ids[0]]);
    const first = runs.listRuns({ limit: 2 });
    expect(first.runs.map((run) => run.id)).toEqual([ids[4], ids[3]]);
    expect(first.nextBefore).toBe(ids[3]);
    const second = runs.listRuns({ limit: 2, before: first.nextBefore! });
    expect(second.runs.map((run) => run.id)).toEqual([ids[2], ids[1]]);
    const last = runs.listRuns({ limit: 2, before: second.nextBefore! });
    expect(last.runs.map((run) => run.id)).toEqual([ids[0]]);
    expect(last.nextBefore).toBeNull();
    expect(runs.listRuns({ before: "bhr_gone" }).runs).toEqual([]);
    expect(runs.listRuns({ limit: 100_000 }).runs).toHaveLength(5);
  });

  it("reports a hook's newest run", () => {
    expect(runs.lastRunOf("h")).toBeUndefined();
    runs.insertRun({ ...base, status: "suppressed", action: "none" }, 1_000_000);
    const newer = runs.insertRun({ ...base, status: "running" }, 2_000_000);
    runs.finishRun(newer, { status: "ok" });
    expect(runs.lastRunOf("h")).toEqual({ startedAt: new Date(2_000_000).toISOString(), status: "ok" });
  });

  it("prunes rows older than 30 days at write time, at most hourly, keeping running rows", () => {
    const now = Date.now();
    const old = now - runs.RETENTION_MS - 1000;
    const oldDone = runs.insertRun({ ...base, status: "suppressed", action: "none" }, old);
    const oldRunning = runs.insertRun({ ...base, status: "running" }, old);
    // The first write after the interval prunes; the inserts above already used the interval for `old`.
    expect(runs.getRun(oldDone)).toBeDefined();
    runs.__resetBoardHookPruneForTest();
    const fresh = runs.insertRun({ ...base, status: "suppressed", action: "none" }, now);
    expect(runs.getRun(oldDone)).toBeUndefined();
    expect(runs.getRun(oldRunning)).toBeDefined();
    expect(runs.getRun(fresh)).toBeDefined();
    // Within the hour a second write does not prune again.
    const stale = runs.insertRun({ ...base, status: "suppressed", action: "none" }, old);
    runs.insertRun({ ...base, status: "suppressed", action: "none" }, now + 1000);
    expect(runs.getRun(stale)).toBeDefined();
  });

  it("prunes rows beyond the newest 10,000", () => {
    const now = Date.now();
    const insert = db.prepare(
      `INSERT INTO board_hook_runs (id, fire_id, hook, event, event_id, todo_id, action, status, payload, chain, started_at, started_ms)
       VALUES (?, 'f', 'h', 'todo.created', 'e', 'TSK-1', 'none', 'suppressed', '{}', '[]', ?, ?)`,
    );
    db.transaction(() => {
      for (let n = 0; n < runs.RETENTION_ROWS + 25; n += 1) insert.run(`bhr_fill_${n}`, new Date(now - n).toISOString(), now - n);
    })();
    runs.pruneRuns(now);
    expect(db.prepare("SELECT COUNT(*) FROM board_hook_runs").pluck().get()).toBe(runs.RETENTION_ROWS);
    expect(runs.getRun("bhr_fill_0")).toBeDefined();
    expect(runs.getRun(`bhr_fill_${runs.RETENTION_ROWS + 24}`)).toBeUndefined();
  });

  it("finds the chain a fire's spawn recorded", () => {
    runs.insertRun({ ...base, fireId: "bhf_chain", status: "running", chain: ["a", "b"] });
    runs.insertRun({ ...base, fireId: "bhf_chain", action: "command", status: "running", chain: ["ignored"] });
    expect(runs.chainOfFire("bhf_chain")).toEqual(["a", "b"]);
    expect(runs.chainOfFire("bhf_unknown")).toEqual([]);
  });
});
