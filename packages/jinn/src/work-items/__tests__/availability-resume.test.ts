import { describe, it, expect, beforeAll, vi } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Point the registry DB at a throwaway dir BEFORE importing it (SESSIONS_DB is
// resolved from JINN_HOME at module load). This keeps the suite off the live DB.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-resume-"));
process.env.JINN_HOME = tmp;

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
const QUOTA_WITH_RESET = "Usage limit exceeded; try again at 2026-08-20T11:30:00.000Z";
const OUTAGE = "Interactive turn failed: server_error";

function minutesBefore(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

/** A Todo parked exactly as a killed attempt leaves one: one settled run whose
 *  error is the provider's own account of why it stopped. */
function parked(title: string, settle: {
  outcome: import("../runs.js").TodoRunOutcome;
  endedAt: string;
  error?: string;
  status?: import("../store.js").WorkItemStatus;
  engine?: string;
  open?: boolean;
}): { id: string; runId: string } {
  const item = store.createWorkItem({ title, status: settle.status ?? "executing" });
  const sessionId = `s-${item.id}`;
  db.prepare(
    `INSERT INTO sessions (id, engine, source, source_ref, status, work_item_id, created_at, last_activity)
     VALUES (?, ?, 'cron', ?, 'idle', ?, ?, ?)`,
  ).run(sessionId, settle.engine ?? "claude", `cron:${sessionId}`, item.id, minutesBefore(240), minutesBefore(240));
  const run = runs.openWorkItemRun({ workItemId: item.id, sessionId, startedAt: minutesBefore(240) });
  if (!settle.open) {
    runs.closeWorkItemRun(run.id, {
      outcome: settle.outcome, endedAt: settle.endedAt, ...(settle.error ? { error: settle.error } : {}),
    });
  }
  return { id: item.id, runId: run.id };
}

/** A port that records what it was asked to re-arm and reports where it landed,
 *  so the sweep's decisions are observable without a Workflow behind them. */
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
  health = await import("../../shared/engine-health.js");
  db = (await import("../../shared/db.js")).initDb();
});

describe("re-arming once a stated reset has passed", () => {
  it("moves the Todo through the port and records exactly one resume naming the run", () => {
    const { id, runId } = parked("stated reset passed", {
      outcome: "rate_limited", endedAt: minutesBefore(90), error: QUOTA_WITH_RESET,
    });
    const port = recorder();

    expect(resume.sweepAvailabilityResumes({ rearm: port.rearm, now: () => NOW })).toBeGreaterThanOrEqual(1);

    expect(port.calls).toContain(id);
    const [event, ...rest] = resumeEvents(id, runId);
    expect(rest).toHaveLength(0);
    expect(event?.detail).toMatchObject({ source: "stated", status: "assigned", engine: "claude" });
    expect(event?.detail?.resetAt).toBe("2026-08-20T11:30:00.000Z");
  });

  it("writes nothing on a second tick over unchanged state", () => {
    const { id, runId } = parked("resumed twice", {
      outcome: "rate_limited", endedAt: minutesBefore(90), error: QUOTA_WITH_RESET,
    });
    const port = recorder();
    resume.sweepAvailabilityResumes({ rearm: port.rearm, now: () => NOW });
    const first = port.calls.filter((call) => call === id).length;

    resume.sweepAvailabilityResumes({ rearm: port.rearm, now: () => NOW });

    expect(port.calls.filter((call) => call === id)).toHaveLength(first);
    expect(resumeEvents(id, runId)).toHaveLength(1);
  });

  it("leaves a window that has not reopened alone", () => {
    const { id, runId } = parked("reset still ahead", {
      outcome: "rate_limited", endedAt: minutesBefore(10),
      error: "Usage limit exceeded; try again at 2026-08-20T18:00:00.000Z",
    });
    const port = recorder();

    resume.sweepAvailabilityResumes({ rearm: port.rearm, now: () => NOW });

    expect(port.calls).not.toContain(id);
    expect(resumeEvents(id, runId)).toHaveLength(0);
    expect(store.getWorkItem(id)?.status).toBe("executing");
  });
});

describe("guards still decide", () => {
  it("defers to a hold and names the guard that refused", () => {
    // Credentials, which no clock fixes — but the text also states a reset, so
    // the sweep would otherwise call this due.
    const { id, runId } = parked("held on auth", {
      outcome: "crashed", endedAt: minutesBefore(90),
      error: `401 Unauthorized: invalid api key. ${OUTAGE}; retry at 2026-08-20T11:30:00.000Z`,
    });
    const port = recorder();

    resume.sweepAvailabilityResumes({ rearm: port.rearm, now: () => NOW });

    expect(port.calls).not.toContain(id);
    expect(resumeEvents(id, runId)).toHaveLength(0);
    const holds = store.listWorkItemEvents(id).filter((event) => event.kind === "respawn_guard_held");
    expect(holds).toHaveLength(1);
    expect(holds[0]?.detail).toMatchObject({ guard: "blocker_auth" });
  });

  it("says a standing hold once rather than on every tick", () => {
    const { id } = parked("held twice", {
      outcome: "crashed", endedAt: minutesBefore(90),
      error: `403 Forbidden: expired credential. ${OUTAGE}; retry at 2026-08-20T11:30:00.000Z`,
    });
    const port = recorder();

    resume.sweepAvailabilityResumes({ rearm: port.rearm, now: () => NOW });
    resume.sweepAvailabilityResumes({ rearm: port.rearm, now: () => NOW });

    expect(store.listWorkItemEvents(id).filter((event) => event.kind === "respawn_guard_held")).toHaveLength(1);
  });
});

describe("where the reopening time comes from", () => {
  it("believes what the engine stated over anything else", () => {
    // The cooldown floor would still be holding this back at +30m from a run
    // that ended 10 minutes ago; the stated time is 30 minutes in the past.
    const { id, runId } = parked("stated wins", {
      outcome: "crashed", endedAt: minutesBefore(10), error: `${OUTAGE}; retry at 2026-08-20T11:30:00.000Z`,
    });

    resume.sweepAvailabilityResumes({ rearm: recorder().rearm, now: () => NOW });

    expect(resumeEvents(id, runId)[0]?.detail).toMatchObject({ source: "stated" });
  });

  it("falls to the engine's own health record when the failure named no time", () => {
    // Recorded exhausted until a moment now past: engine health reads the window
    // as closed, which the 30-minute cooldown floor would not have done yet.
    health.recordEngineUnavailable("grok", "quota", Math.floor(NOW.getTime() / 1000) - 600,
      new Date(NOW.getTime() - 3_600_000));
    const { id, runId } = parked("health decides", {
      outcome: "crashed", endedAt: minutesBefore(10), error: OUTAGE, engine: "grok",
    });

    resume.sweepAvailabilityResumes({ rearm: recorder().rearm, now: () => NOW });

    expect(resumeEvents(id, runId)[0]?.detail).toMatchObject({ source: "engine-health", engine: "grok" });
  });

  it("falls to the shared cooldown when neither said anything", () => {
    const { id, runId } = parked("cooldown decides", {
      outcome: "crashed", endedAt: minutesBefore(45), error: OUTAGE, engine: "pi",
    });

    resume.sweepAvailabilityResumes({ rearm: recorder().rearm, now: () => NOW });

    const detail = resumeEvents(id, runId)[0]?.detail;
    expect(detail).toMatchObject({ source: "cooldown" });
    expect(detail?.resetAt).toBe(new Date(NOW.getTime() - 15 * 60_000).toISOString());
  });

  it("waits out the cooldown it fell back to", () => {
    const { id, runId } = parked("cooldown still running", {
      outcome: "crashed", endedAt: minutesBefore(5), error: OUTAGE, engine: "pi",
    });

    resume.sweepAvailabilityResumes({ rearm: recorder().rearm, now: () => NOW });

    expect(resumeEvents(id, runId)).toHaveLength(0);
  });
});

describe("what the sweep will not touch", () => {
  it("skips a Todo somebody already closed", () => {
    const { id, runId } = parked("closed", {
      outcome: "rate_limited", endedAt: minutesBefore(90), error: QUOTA_WITH_RESET, status: "done",
    });
    const cancelled = parked("cancelled", {
      outcome: "rate_limited", endedAt: minutesBefore(90), error: QUOTA_WITH_RESET, status: "cancelled",
    });

    resume.sweepAvailabilityResumes({ rearm: recorder().rearm, now: () => NOW });

    expect(resumeEvents(id, runId)).toHaveLength(0);
    expect(resumeEvents(cancelled.id, cancelled.runId)).toHaveLength(0);
  });

  it("skips a Todo with an attempt still running", () => {
    const { id } = parked("still working", {
      outcome: "rate_limited", endedAt: minutesBefore(90), error: QUOTA_WITH_RESET, open: true,
    });

    resume.sweepAvailabilityResumes({ rearm: recorder().rearm, now: () => NOW });

    expect(store.listWorkItemEvents(id).filter((event) => event.kind === "availability_resumed")).toHaveLength(0);
  });

  it("skips a nameless failure old enough that resuming it would resurrect history", () => {
    const { id, runId } = parked("yesterday", {
      outcome: "crashed", endedAt: minutesBefore(25 * 60), error: OUTAGE,
    });

    resume.sweepAvailabilityResumes({ rearm: recorder().rearm, now: () => NOW });

    expect(resumeEvents(id, runId)).toHaveLength(0);
  });

  it("skips a failure a retry could actually fix", () => {
    const { id, runId } = parked("ordinary failure", {
      outcome: "crashed", endedAt: minutesBefore(90), error: "the build step exited with code 1",
    });

    resume.sweepAvailabilityResumes({ rearm: recorder().rearm, now: () => NOW });

    expect(resumeEvents(id, runId)).toHaveLength(0);
  });
});

describe("sweep hygiene", () => {
  it("never holds the process open", () => {
    const timers = vi.spyOn(globalThis, "setInterval");

    const stop = resume.startAvailabilityResumeSweep({ rearm: recorder().rearm, now: () => NOW }, 60_000);
    const timer = timers.mock.results[0]?.value as NodeJS.Timeout;

    expect(timer.hasRef()).toBe(false);
    stop();
    timers.mockRestore();
  });

  it("ticks, and stops ticking when told", () => {
    parked("periodic", { outcome: "rate_limited", endedAt: minutesBefore(90), error: QUOTA_WITH_RESET });
    const port = recorder();
    vi.useFakeTimers();

    const stop = resume.startAvailabilityResumeSweep({ rearm: port.rearm, now: () => NOW }, 20);
    vi.advanceTimersByTime(20);
    const ticked = port.calls.length;
    stop();
    vi.advanceTimersByTime(200);

    expect(ticked).toBeGreaterThan(0);
    expect(port.calls).toHaveLength(ticked);
    vi.useRealTimers();
  });

  it("keeps a failing sweep inside its own tick", () => {
    parked("port throws", { outcome: "rate_limited", endedAt: minutesBefore(90), error: QUOTA_WITH_RESET });
    vi.useFakeTimers();
    const stop = resume.startAvailabilityResumeSweep({
      rearm: () => { throw new Error("the workflow repository is gone"); }, now: () => NOW,
    }, 20);

    expect(() => vi.advanceTimersByTime(20)).not.toThrow();

    stop();
    vi.useRealTimers();
  });
});
