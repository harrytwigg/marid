import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-resume-weekly-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type Runs = typeof import("../runs.js");
type Resume = typeof import("../availability-resume.js");

let store: Store;
let runs: Runs;
let resume: Resume;
let db: import("better-sqlite3").Database;

const NOW = new Date("2026-08-20T12:00:00.000Z");

function minutesBefore(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

function parked(title: string, settle: {
  outcome: import("../runs.js").TodoRunOutcome;
  endedAt: string;
  error?: string;
}): { id: string; runId: string } {
  const item = store.createWorkItem({ title, status: "executing" });
  const sessionId = `s-${item.id}`;
  db.prepare(
    `INSERT INTO sessions (id, engine, source, source_ref, status, work_item_id, created_at, last_activity)
     VALUES (?, 'claude', 'cron', ?, 'idle', ?, ?, ?)`,
  ).run(sessionId, `cron:${sessionId}`, item.id, minutesBefore(240), minutesBefore(240));
  const run = runs.openWorkItemRun({ workItemId: item.id, sessionId, startedAt: minutesBefore(240) });
  runs.closeWorkItemRun(run.id, {
    outcome: settle.outcome, endedAt: settle.endedAt, ...(settle.error ? { error: settle.error } : {}),
  });
  return { id: item.id, runId: run.id };
}

function recorder(): { calls: string[]; rearm: (id: string) => { status: string } } {
  const calls: string[] = [];
  return { calls, rearm: (id) => { calls.push(id); return { status: "assigned" }; } };
}

function resumeEvents(workItemId: string, runId: string) {
  return store.listWorkItemEvents(workItemId)
    .filter((event) => event.kind === "availability_resumed" && event.detail?.runId === runId);
}

beforeAll(async () => {
  store = await import("../store.js");
  runs = await import("../runs.js");
  resume = await import("../availability-resume.js");
  db = (await import("../../shared/db.js")).initDb();
});

describe("weekly-capped work waits for the named reset (PLA-216)", () => {
  it("resumes after the stated reset even when endedAt is older than 24h", () => {
    const resetAt = new Date(NOW.getTime() - 60_000).toISOString();
    const { id, runId } = parked("weekly cap", {
      outcome: "rate_limited",
      endedAt: minutesBefore(6 * 24 * 60),
      error: `Usage limit exceeded; try again at ${resetAt}`,
    });
    const port = recorder();

    resume.sweepAvailabilityResumes({ rearm: port.rearm, now: () => NOW });

    expect(port.calls).toContain(id);
    expect(resumeEvents(id, runId)[0]?.detail).toMatchObject({ source: "stated" });
  });

  it("does not resume a weekly cap whose reset is still in the future", () => {
    const resetAt = new Date(NOW.getTime() + 2 * 24 * 60 * 60_000).toISOString();
    const { id, runId } = parked("weekly cap still closed", {
      outcome: "rate_limited",
      endedAt: minutesBefore(2 * 24 * 60),
      error: `Usage limit exceeded; try again at ${resetAt}`,
    });

    resume.sweepAvailabilityResumes({ rearm: recorder().rearm, now: () => NOW });

    expect(resumeEvents(id, runId)).toHaveLength(0);
  });
});
