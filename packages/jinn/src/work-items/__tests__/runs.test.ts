import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Point the registry DB at a throwaway dir BEFORE importing it (SESSIONS_DB is
// resolved from JINN_HOME at module load). This keeps the suite off the live DB.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-runs-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type Runs = typeof import("../runs.js");
let store: Store;
let runs: Runs;
let db: import("better-sqlite3").Database;

beforeAll(async () => {
  store = await import("../store.js");
  runs = await import("../runs.js");
  db = (await import("../../shared/db.js")).initDb();
});

describe("openWorkItemRun", () => {
  it("writes one open row — no end, no outcome, empty handoff", () => {
    const item = store.createWorkItem({ title: "run host" });
    const run = runs.openWorkItemRun({ workItemId: item.id, sessionId: "s-open", startedAt: "2026-08-13T10:00:00.000Z" });
    expect(run.id).toMatch(/^wir_[0-9a-f]{12}$/);
    expect(run.workItemId).toBe(item.id);
    expect(run.sessionId).toBe("s-open");
    expect(run.startedAt).toBe("2026-08-13T10:00:00.000Z");
    expect(run.endedAt).toBeNull();
    expect(run.outcome).toBeNull();
    expect(run.handoff).toEqual({});
    expect(runs.listWorkItemRuns(item.id)).toEqual([run]);
  });

  it("returns the run already open for the same session instead of a second row", () => {
    const item = store.createWorkItem({ title: "reopen host" });
    const first = runs.openWorkItemRun({ workItemId: item.id, sessionId: "s-dup" });
    const again = runs.openWorkItemRun({ workItemId: item.id, sessionId: "s-dup" });
    expect(again.id).toBe(first.id);
    expect(runs.listWorkItemRuns(item.id)).toHaveLength(1);
  });

  it("refuses a run on a Todo that does not exist", () => {
    expect(() => runs.openWorkItemRun({ workItemId: "ZZZ-9999", sessionId: "s-ghost" })).toThrow(/ZZZ-9999/);
  });
});

describe("closeWorkItemRun", () => {
  it("stamps the end, the outcome, the summary and the normalized handoff", () => {
    const item = store.createWorkItem({ title: "close host" });
    const open = runs.openWorkItemRun({ workItemId: item.id, sessionId: "s-close" });
    const closed = runs.closeWorkItemRun(open.id, {
      outcome: "completed",
      summary: "shipped the slice",
      handoff: {
        changedFiles: ["src/a.ts", "src/b.ts"],
        verification: "pnpm test",
        retryNotes: "none",
        residualRisk: "none",
      },
      endedAt: "2026-08-13T11:00:00.000Z",
    });
    expect(closed.endedAt).toBe("2026-08-13T11:00:00.000Z");
    expect(closed.outcome).toBe("completed");
    expect(closed.summary).toBe("shipped the slice");
    expect(closed.handoff).toEqual({
      changedFiles: ["src/a.ts", "src/b.ts"],
      verification: "pnpm test",
      retryNotes: "none",
      residualRisk: "none",
    });
    expect(runs.listWorkItemRuns(item.id)[0]).toEqual(closed);
  });

  it("drops handoff keys nobody declared", () => {
    const item = store.createWorkItem({ title: "handoff host" });
    const open = runs.openWorkItemRun({ workItemId: item.id, sessionId: "s-unknown" });
    const closed = runs.closeWorkItemRun(open.id, {
      outcome: "blocked",
      handoff: { verification: "pnpm lint", secret: "leak", changedFiles: ["x.ts", 7], residualRisk: 12 },
    });
    expect(closed.handoff).toEqual({ verification: "pnpm lint", changedFiles: ["x.ts"] });
  });

  it("rejects an outcome outside the five the ledger knows", () => {
    const item = store.createWorkItem({ title: "bad outcome host" });
    const open = runs.openWorkItemRun({ workItemId: item.id, sessionId: "s-bad" });
    expect(() => runs.closeWorkItemRun(open.id, { outcome: "succeeded" as never })).toThrow(/outcome/i);
    expect(runs.listWorkItemRuns(item.id)[0].endedAt).toBeNull();
  });

  it("refuses to close a run twice — a second summary can never overwrite the first", () => {
    const item = store.createWorkItem({ title: "double close host" });
    const open = runs.openWorkItemRun({ workItemId: item.id, sessionId: "s-twice" });
    runs.closeWorkItemRun(open.id, { outcome: "completed", summary: "first" });
    expect(() => runs.closeWorkItemRun(open.id, { outcome: "blocked", summary: "second" })).toThrow(/already closed/i);
    expect(runs.listWorkItemRuns(item.id)[0].summary).toBe("first");
  });

  it("refuses a run id nobody minted", () => {
    expect(() => runs.closeWorkItemRun("wir_000000000000", { outcome: "completed" })).toThrow(/not found/i);
  });
});

describe("the run ledger's shape", () => {
  it("closes exactly one run per call — no exported function takes a list of run ids", async () => {
    // AC3: one shared summary must never settle two attempts. The guarantee is
    // structural, so it is checked structurally: every exported function that
    // closes anything takes a single run id.
    const source = await fs.promises.readFile(new URL("../runs.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/runIds|ids:\s*(readonly\s+)?string\[\]/);
    expect(runs.closeWorkItemRun.length).toBe(2);
  });

  it("lists a Todo's runs oldest first and reads a retried attempt's predecessor back", () => {
    const item = store.createWorkItem({ title: "retry host" });
    const first = runs.openWorkItemRun({ workItemId: item.id, sessionId: "s-a", startedAt: "2026-08-13T09:00:00.000Z" });
    runs.closeWorkItemRun(first.id, {
      outcome: "crashed",
      summary: "transport died",
      handoff: { retryNotes: "the fixture was missing" },
    });
    const second = runs.openWorkItemRun({ workItemId: item.id, sessionId: "s-b", startedAt: "2026-08-13T09:30:00.000Z" });
    const listed = runs.listWorkItemRuns(item.id);
    expect(listed.map((run) => run.id)).toEqual([first.id, second.id]);
    expect(listed[0].summary).toBe("transport died");
    expect(listed[0].handoff).toEqual({ retryNotes: "the fixture was missing" });
    expect(listed[1].endedAt).toBeNull();
  });

  it("finds the open run for a session and stops finding it once closed", () => {
    const item = store.createWorkItem({ title: "lookup host" });
    const run = runs.openWorkItemRun({ workItemId: item.id, sessionId: "s-lookup" });
    expect(runs.findOpenWorkItemRunBySession("s-lookup")?.id).toBe(run.id);
    runs.closeWorkItemRun(run.id, { outcome: "abandoned" });
    expect(runs.findOpenWorkItemRunBySession("s-lookup")).toBeUndefined();
  });
});

describe("closeOrphanedWorkItemRuns", () => {
  it("closes an open run whose session is gone as crashed, and leaves live ones alone", () => {
    const item = store.createWorkItem({ title: "orphan host" });
    const orphan = runs.openWorkItemRun({ workItemId: item.id, sessionId: "s-vanished" });
    const live = runs.openWorkItemRun({ workItemId: item.id, sessionId: "s-present" });
    db.prepare(
      `INSERT INTO sessions (id, engine, source, source_ref, status, created_at, last_activity)
       VALUES ('s-present', 'claude', 'web', 'web', 'running', ?, ?)`,
    ).run("2026-08-13T09:00:00.000Z", "2026-08-13T09:00:00.000Z");

    expect(runs.closeOrphanedWorkItemRuns("2026-08-13T12:00:00.000Z")).toBeGreaterThanOrEqual(1);

    const byId = new Map(runs.listWorkItemRuns(item.id).map((run) => [run.id, run]));
    expect(byId.get(orphan.id)?.outcome).toBe("crashed");
    expect(byId.get(orphan.id)?.endedAt).toBe("2026-08-13T12:00:00.000Z");
    expect(byId.get(orphan.id)?.error).toMatch(/session/i);
    expect(byId.get(live.id)?.outcome).toBeNull();
    expect(runs.closeOrphanedWorkItemRuns("2026-08-13T12:00:01.000Z")).toBe(0);
  });
});

describe("a quota window is not a failure (ISS-731)", () => {
  /** A session that already reported its receipt, so the settled-session sweep
   *  is the thing deciding what the run's outcome reads as. */
  function settledSession(id: string, outcome: string, lastError: string | null, workItemId: string | null = null): void {
    db.prepare(
      `INSERT INTO sessions (id, engine, source, source_ref, status, attempt_outcome, last_error, work_item_id, created_at, last_activity)
       VALUES (?, 'claude', 'web', 'web', 'error', ?, ?, ?, ?, ?)`,
    ).run(id, outcome, lastError, workItemId, "2026-08-13T09:00:00.000Z", "2026-08-13T09:00:00.000Z");
  }

  it("accepts and persists an explicit rate_limited close", () => {
    const item = store.createWorkItem({ title: "quota host" });
    const run = runs.openWorkItemRun({ workItemId: item.id, sessionId: "s-quota" });
    expect(runs.closeWorkItemRun(run.id, { outcome: "rate_limited" }).outcome).toBe("rate_limited");
    expect(runs.listWorkItemRuns(item.id)[0].outcome).toBe("rate_limited");
  });

  it("settles a rate-limit-shaped receipt as rate_limited rather than blocked", () => {
    const item = store.createWorkItem({ title: "receipt host" });
    const run = runs.openWorkItemRun({ workItemId: item.id, sessionId: "s-429" });
    settledSession("s-429", "failed", "429 Too Many Requests: usage limit exceeded, retry after the window");

    runs.closeRunsForSettledSessions("2026-08-13T12:00:00.000Z");

    expect(runs.listWorkItemRuns(item.id).find((entry) => entry.id === run.id)?.outcome).toBe("rate_limited");
  });

  it("reads the receipt the same way when the per-Todo reconciler reaches it first", async () => {
    // Two settlers race for every attempt: this sweep and the reconciler. If
    // they disagree, a quota window reads as `blocked` purely because of which
    // one arrived first — and `blocked` is what the respawn guards take to mean
    // a human has to clear it.
    const { reconcileWorkItem } = await import("../reconcile.js");
    const item = store.createWorkItem({ title: "reconciled quota host" });
    const run = runs.openWorkItemRun({ workItemId: item.id, sessionId: "s-429-reconciled" });
    settledSession("s-429-reconciled", "failed", "429 Too Many Requests: usage limit exceeded", item.id);

    reconcileWorkItem(item.id);

    expect(runs.listWorkItemRuns(item.id).find((entry) => entry.id === run.id)?.outcome).toBe("rate_limited");
  });

  it("leaves an ordinary failed receipt reading as blocked", () => {
    const item = store.createWorkItem({ title: "ordinary host" });
    const run = runs.openWorkItemRun({ workItemId: item.id, sessionId: "s-fail" });
    settledSession("s-fail", "failed", "the build step exited with code 1");

    runs.closeRunsForSettledSessions("2026-08-13T12:00:00.000Z");

    expect(runs.listWorkItemRuns(item.id).find((entry) => entry.id === run.id)?.outcome).toBe("blocked");
  });
});
