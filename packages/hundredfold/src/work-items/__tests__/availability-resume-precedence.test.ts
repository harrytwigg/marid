import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Point the registry DB at a throwaway dir BEFORE importing it (SESSIONS_DB is
// resolved from HUNDREDFOLD_HOME at module load). This keeps the suite off the live DB.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-wi-resume-order-"));
process.env.HUNDREDFOLD_HOME = tmp;

/* Which answer decides when a parked Todo comes back, when two of them disagree.
 * The sweep's candidate selection and its hygiene live in the sibling file. */

type Store = typeof import("../store.js");
type Runs = typeof import("../runs.js");
type Resume = typeof import("../availability-resume.js");
type Health = typeof import("../../shared/engine-health.js");

let store: Store;
let runs: Runs;
let resume: Resume;
let health: Health;
let db: import("better-sqlite3").Database;

const NOW = new Date("2026-08-20T12:00:00.000Z");
const OUTAGE = "Interactive turn failed: server_error";

/** A Todo parked exactly as a killed attempt leaves one, ten minutes ago — well
 *  inside the 30-minute cooldown that is the answer of last resort. */
function parked(title: string, settle: {
  outcome: import("../runs.js").TodoRunOutcome;
  error: string;
  engine?: string;
}): { id: string; runId: string } {
  const item = store.createWorkItem({ title, status: "executing" });
  const sessionId = `s-${item.id}`;
  const tenMinutesAgo = new Date(NOW.getTime() - 10 * 60_000).toISOString();
  db.prepare(
    `INSERT INTO sessions (id, engine, source, source_ref, status, work_item_id, created_at, last_activity)
     VALUES (?, ?, 'cron', ?, 'idle', ?, ?, ?)`,
  ).run(sessionId, settle.engine ?? "claude", `cron:${sessionId}`, item.id, tenMinutesAgo, tenMinutesAgo);
  const run = runs.openWorkItemRun({ workItemId: item.id, sessionId, startedAt: tenMinutesAgo });
  runs.closeWorkItemRun(run.id, { outcome: settle.outcome, endedAt: tenMinutesAgo, error: settle.error });
  return { id: item.id, runId: run.id };
}

function sweep(): void {
  resume.sweepAvailabilityResumes({ rearm: () => ({ status: "assigned" }), now: () => NOW });
}

function resumeEvents(workItemId: string, runId: string) {
  return store.listWorkItemEvents(workItemId)
    .filter((event) => event.kind === "availability_resumed" && event.detail?.runId === runId);
}

beforeAll(async () => {
  store = await import("../store.js");
  runs = await import("../runs.js");
  resume = await import("../availability-resume.js");
  health = await import("../../shared/engine-health.js");
  db = (await import("../../shared/db.js")).initDb();
});

describe("a reset the engine named beats the generic cooldown", () => {
  it("resumes on the stated time even though the cooldown guard would still be holding", () => {
    // Quota-shaped text trips `rate_limit_cooldown`, whose generic answer is
    // "not before 12:20". The failure named 11:55, which is the better answer to
    // the same question, so re-asking the guard must not override it.
    const { id, runId } = parked("stated beats the cooldown guard", {
      outcome: "rate_limited", error: "Usage limit exceeded; try again at 2026-08-20T11:55:00.000Z",
    });

    sweep();

    expect(resumeEvents(id, runId)[0]?.detail).toMatchObject({ source: "stated" });
    expect(store.listWorkItemEvents(id).filter((event) => event.kind === "respawn_guard_held")).toHaveLength(0);
  });

  it("still lets the guards that read other facts refuse", () => {
    // The skip is narrow: quota vocabulary routinely arrives alongside the
    // credential vocabulary, and a retry still cannot mint credentials.
    const { id, runId } = parked("auth still holds", {
      outcome: "crashed",
      error: "Usage limit exceeded; try again at 2026-08-20T11:55:00.000Z. Also 401 Unauthorized: invalid api key",
    });

    sweep();

    expect(resumeEvents(id, runId)).toHaveLength(0);
    const holds = store.listWorkItemEvents(id).filter((event) => event.kind === "respawn_guard_held");
    expect(holds[0]?.detail).toMatchObject({ guard: "blocker_auth" });
  });
});

describe("a live engine-health record names the moment, not the state", () => {
  it("waits out a degraded window that has not closed yet", () => {
    // `degraded` is a weaker claim about the engine, not a claim about a
    // different time: recorded at 11:55, its 15-minute window runs to 12:10.
    health.recordEngineUnavailable("hermes", "flaky", undefined, new Date(NOW.getTime() - 5 * 60_000));
    const { id, runId } = parked("degraded window still open", {
      outcome: "crashed", error: OUTAGE, engine: "hermes",
    });

    sweep();

    expect(resumeEvents(id, runId)).toHaveLength(0);
  });

  it("resumes once that window has passed", () => {
    health.recordEngineUnavailable("grok", "flaky", undefined, new Date(NOW.getTime() - 20 * 60_000));
    const { id, runId } = parked("degraded window closed", {
      outcome: "crashed", error: OUTAGE, engine: "grok",
    });

    sweep();

    expect(resumeEvents(id, runId)[0]?.detail).toMatchObject({ source: "engine-health" });
  });
});
