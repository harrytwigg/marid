import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";

/**
 * Contract for the per-domain router seam (`cron-api.ts`, `org-api.ts`). Every
 * moved route is driven through handleApiRequest — the delegation, not the module —
 * and pinned exactly to what it returned while inline.
 * Those assertions are green on the pre-move commit too, by design: byte-identical
 * responses either side of the move is the claim. What is new is the seam, and each
 * of its properties goes red when broken — the authority gate fires before
 * delegating, an adjacent unmatched path falls through, and a throw inside a module
 * still lands in api.ts's 500 envelope.
 *
 * This file owns the seam itself. The cron and org payloads live in
 * cron-router-contract.test.ts and org-router-contract.test.ts; the rig all three
 * share is domain-router-harness.ts, over the temp home in domain-router-home.ts.
 */

/** Set by the tests that need a delegated handler to blow up mid-request. */
let cronRunsThrows = false;

vi.mock("../../shared/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/paths.js")>();
  const { home } = await import("./domain-router-home.js");
  return {
    ...actual,
    get CRON_RUNS() {
      if (cronRunsThrows) throw new Error("forced cron paths failure");
      return home.cronRuns;
    },
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

import { JOBS, home, seedHome } from "./domain-router-home.js";
import { call } from "./domain-router-harness.js";

beforeEach(() => {
  cronRunsThrows = false;
  runCronJob.mockClear();
  seedHome();
});

describe("the seam itself", () => {
  it("still runs the operator-only control-plane gate before delegating", async () => {
    const gated = [
      { method: "POST", url: "/api/cron", body: { id: "sneaky", name: "Sneaky", schedule: "* * * * *" } },
      { method: "PUT", url: "/api/cron/nightly", body: { enabled: false } },
      { method: "DELETE", url: "/api/cron/nightly", body: undefined },
      { method: "POST", url: "/api/cron/nightly/trigger", body: {} },
      { method: "PATCH", url: "/api/org/employees/worker", body: { model: "gpt-5.5" } },
    ];
    for (const route of gated) {
      const r = await call(route.method, route.url, route.body, {});
      expect(`${route.method} ${route.url} → ${r.status}`).toBe(`${route.method} ${route.url} → 403`);
    }
    // The gate ran instead of the handler: nothing was scheduled, nothing fired.
    expect(runCronJob).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(home.cronJobs, "utf-8"))).toEqual(JOBS);
  });

  it("falls through on an adjacent unmatched path instead of swallowing it", async () => {
    const r = await call("GET", "/api/cronx");
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: "Not found" });

    const orgish = await call("GET", "/api/orgx");
    expect(orgish.status).toBe(404);
  });

  it("lets a throw inside a delegated module reach api.ts's 500 envelope", async () => {
    cronRunsThrows = true;
    const r = await call("GET", "/api/cron");
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: "forced cron paths failure" });
  });
});
