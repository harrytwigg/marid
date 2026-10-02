import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The `/api/cron*` half of the domain-router contract. Every moved route is driven
 * through handleApiRequest — the delegation, not the module — and pinned exactly to
 * what it returned while inline. The seam's own properties live in
 * domain-router-contract.test.ts; this file only pins the payloads.
 */

vi.mock("../../shared/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/paths.js")>();
  const { home } = await import("./domain-router-home.js");
  return {
    ...actual,
    get CRON_RUNS() { return home.cronRuns; },
    get CRON_JOBS() { return home.cronJobs; },
    get ORG_DIR() { return home.org; },
  };
});

vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// The two cron side effects that reach outside the request: rescheduling and
// actually firing a job.
vi.mock("../../cron/scheduler.js", () => ({ reloadScheduler: vi.fn() }));
const runCronJob = vi.fn(async () => {});
vi.mock("../../cron/runner.js", () => ({ runCronJob: (...args: unknown[]) => runCronJob(...(args as [])) }));

import { JOBS, RUN_SESSION_ID, seedHome } from "./domain-router-home.js";
import { call } from "./domain-router-harness.js";

beforeEach(() => {
  runCronJob.mockClear();
  seedHome();
});

describe("cron routes still answer identically through handleCronApi", () => {
  it("GET /api/cron returns the enriched summary list", async () => {
    const r = await call("GET", "/api/cron");
    expect(r.status).toBe(200);
    expect(r.body).toEqual([
      {
        id: "nightly",
        name: "Nightly",
        schedule: "0 3 * * *",
        enabled: true,
        employee: "ops",
        engine: null,
        timezone: null,
        action: null,
        lastRun: { timestamp: "2026-08-01T03:00:00.000Z", sessionId: RUN_SESSION_ID, status: "success" },
      },
    ]);
  });

  it("GET /api/cron/:id/runs returns the summarized run tail", async () => {
    const r = await call("GET", "/api/cron/nightly/runs?limit=10");
    expect(r.status).toBe(200);
    expect(r.body).toEqual([{ timestamp: "2026-08-01T03:00:00.000Z", sessionId: RUN_SESSION_ID, status: "success" }]);
  });

  it("POST /api/cron creates a job (201) and rejects a duplicate id (400)", async () => {
    const created = await call("POST", "/api/cron", { id: "weekly", name: "Weekly", schedule: "0 4 * * 1" });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ id: "weekly", name: "Weekly", enabled: true, schedule: "0 4 * * 1", prompt: "" });

    const dupe = await call("POST", "/api/cron", { id: "weekly", name: "Weekly again", schedule: "0 5 * * 1" });
    expect(dupe.status).toBe(400);
    expect(dupe.body).toEqual({ error: 'a cron job with id "weekly" already exists' });
  });

  it("PUT /api/cron/:id merges the update, and 404s an unknown id", async () => {
    const r = await call("PUT", "/api/cron/nightly", { enabled: false });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ...JOBS[0], enabled: false });

    const missing = await call("PUT", "/api/cron/ghost", { enabled: false });
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: "Not found" });
  });

  it("DELETE /api/cron/:id removes the job, and 404s an unknown id", async () => {
    const r = await call("DELETE", "/api/cron/nightly");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ deleted: "nightly", name: "Nightly" });
    expect((await call("DELETE", "/api/cron/nightly")).status).toBe(404);
  });

  it("POST /api/cron/:id/trigger fires the job in the background and 404s an unknown id", async () => {
    const r = await call("POST", "/api/cron/nightly/trigger", {});
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      triggered: true,
      jobId: "nightly",
      name: "Nightly",
      employee: "ops",
      message: 'Cron job "Nightly" triggered manually',
    });
    expect(runCronJob).toHaveBeenCalledTimes(1);

    expect((await call("POST", "/api/cron/ghost/trigger", {})).status).toBe(404);
  });
});

describe("a cron job that runs a built-in action", () => {
  const WALK = { id: "board-walk", name: "Board walk", schedule: "0 * * * *", action: "board-walk" };

  it("is created and listed with its action, and the trigger hands it to the runner as a manual fire", async () => {
    const created = await call("POST", "/api/cron", WALK);
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ ...WALK, enabled: true, prompt: "" });
    const listed = await call("GET", "/api/cron");
    expect((listed.body as Array<Record<string, unknown>>).find((job) => job.id === "board-walk")).toMatchObject({ action: "board-walk", lastRun: null });

    expect((await call("POST", "/api/cron/board-walk/trigger", {})).status).toBe(200);
    expect(runCronJob).toHaveBeenCalledTimes(1);
    const args = runCronJob.mock.calls[0] as unknown[];
    expect(args[0]).toMatchObject({ id: "board-walk", action: "board-walk" });
    expect(args[4]).toMatchObject({ trigger: "manual" });
  });

  it("refuses an unknown action, and a second job for the same action", async () => {
    const unknown = await call("POST", "/api/cron", { ...WALK, action: "self-destruct" });
    expect(unknown.status).toBe(400);
    expect(unknown.body).toEqual({ error: "action must be one of board-walk" });

    expect((await call("POST", "/api/cron", WALK)).status).toBe(201);
    const twin = await call("POST", "/api/cron", { ...WALK, id: "walk-2" });
    expect(twin.status).toBe(400);
    expect(twin.body).toEqual({ error: 'the board-walk action already runs from cron job "board-walk"' });
    // Nor can an existing prompt job be turned into a second one.
    const turned = await call("PUT", "/api/cron/nightly", { action: "board-walk" });
    expect(turned.status).toBe(400);
  });

  it("can be rescheduled and switched off, but not turned into a prompt job", async () => {
    await call("POST", "/api/cron", WALK);
    const moved = await call("PUT", "/api/cron/board-walk", { schedule: "*/30 * * * *", timezone: "Europe/London", enabled: false });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ schedule: "*/30 * * * *", timezone: "Europe/London", enabled: false, action: "board-walk" });

    const stripped = await call("PUT", "/api/cron/board-walk", { action: null, prompt: "do something" });
    expect(stripped.status).toBe(400);
    expect(stripped.body).toEqual({ error: "a cron job's action cannot be changed; create a new job instead" });
  });
});
