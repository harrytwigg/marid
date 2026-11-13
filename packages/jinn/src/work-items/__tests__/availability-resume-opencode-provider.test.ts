import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

/** A Todo whose opencode attempt failed names its reopening from the provider's health record, not the plain engine key the meter no longer writes. */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-resume-oc-"));
process.env.JINN_HOME = tmp;

let store: typeof import("../store.js");
let runs: typeof import("../runs.js");
let resume: typeof import("../availability-resume.js");
let health: typeof import("../../shared/engine-health.js");
let healthStore: typeof import("../../shared/engine-health-store.js");
let db: import("better-sqlite3").Database;

const NOW = new Date("2026-08-20T12:00:00.000Z");
const minutesBefore = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const OUTAGE = "Interactive turn failed: server_error";
const config = { engines: { default: "claude", opencode: { bin: "opencode", model: "opencode-go-b/flash" } } } as never;

function parked(title: string, model: string | null): { id: string; runId: string } {
  const item = store.createWorkItem({ title, status: "executing" });
  const sessionId = `s-${item.id}`;
  db.prepare(
    `INSERT INTO sessions (id, engine, model, source, source_ref, status, work_item_id, created_at, last_activity)
     VALUES (?, 'opencode', ?, 'cron', ?, 'idle', ?, ?, ?)`,
  ).run(sessionId, model, `cron:${sessionId}`, item.id, minutesBefore(240), minutesBefore(240));
  const run = runs.openWorkItemRun({ workItemId: item.id, sessionId, startedAt: minutesBefore(240) });
  runs.closeWorkItemRun(run.id, { outcome: "crashed", endedAt: minutesBefore(10), error: OUTAGE });
  return { id: item.id, runId: run.id };
}

const sweep = () => resume.sweepAvailabilityResumes({ rearm: () => ({ status: "assigned" }), now: () => NOW, config: () => config });
const resumed = (id: string, runId: string) => store.listWorkItemEvents(id).filter((event) => event.kind === "availability_resumed" && event.detail?.runId === runId);

beforeAll(async () => {
  store = await import("../store.js");
  runs = await import("../runs.js");
  resume = await import("../availability-resume.js");
  health = await import("../../shared/engine-health.js");
  healthStore = await import("../../shared/engine-health-store.js");
  db = (await import("../../shared/db.js")).initDb();
});

describe("an opencode attempt that named no time", () => {
  it("falls to its provider's record, by the session's model", () => {
    // The provider's window closed ten minutes ago: the 30-minute cooldown floor would not have said so yet.
    health.recordEngineUnavailable("opencode/opencode-go-b", "quota window spent", Math.floor(NOW.getTime() / 1000) - 600, new Date(NOW.getTime() - 3_600_000));
    const { id, runId } = parked("provider decides", "opencode-go-b/flash");
    sweep();
    expect(resumed(id, runId)[0]?.detail).toMatchObject({ source: "engine-health", engine: "opencode" });
  });

  it("reads the engine's configured model's provider when the session names none", () => {
    health.recordEngineUnavailable("opencode/opencode-go-b", "quota window spent", Math.floor(NOW.getTime() / 1000) - 600, new Date(NOW.getTime() - 3_600_000));
    const { id, runId } = parked("default model's provider decides", null);
    sweep();
    expect(resumed(id, runId)[0]?.detail).toMatchObject({ source: "engine-health" });
  });

  it("does not take another provider's record: the cooldown floor still holds a run that ended 10 minutes ago", () => {
    const { id, runId } = parked("another provider", "opencode-go-c/flash");
    sweep();
    expect(resumed(id, runId)).toHaveLength(0);
  });

  it("waits for a provider window that has not reopened", () => {
    health.recordEngineUnavailable("opencode/opencode-go-d", "quota window spent", Math.floor(NOW.getTime() / 1000) + 3600, NOW);
    const { id, runId } = parked("still spent", "opencode-go-d/flash");
    sweep();
    expect(resumed(id, runId)).toHaveLength(0);
  });
});

describe("several records under an opencode attempt's keys", () => {
  const minutesAfter = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();

  it("waits for the engine-wide exhaustion when the provider's record is ok", () => {
    healthStore.writeStore({ "opencode/opencode-go-e": { state: "ok" }, opencode: { state: "exhausted", until: minutesAfter(120) } });
    const { id, runId } = parked("provider ok, engine spent", "opencode-go-e/flash");
    sweep();
    expect(resumed(id, runId)).toHaveLength(0);
  });

  it("does not resume on a provider's short degraded window while the engine is exhausted", () => {
    // The degraded window closed five minutes ago; the engine-wide exhaustion still runs for two hours.
    healthStore.writeStore({ "opencode/opencode-go-f": { state: "degraded", until: minutesAfter(-5) }, opencode: { state: "exhausted", until: minutesAfter(120) } });
    const { id, runId } = parked("degraded provider, spent engine", "opencode-go-f/flash");
    sweep();
    expect(resumed(id, runId)).toHaveLength(0);
  });

  it("waits for the later of two exhausted records", () => {
    healthStore.writeStore({ "opencode/opencode-go-g": { state: "exhausted", until: minutesAfter(-5) }, opencode: { state: "exhausted", until: minutesAfter(120) } });
    const { id, runId } = parked("two exhausted", "opencode-go-g/flash");
    sweep();
    expect(resumed(id, runId)).toHaveLength(0);
  });
});
