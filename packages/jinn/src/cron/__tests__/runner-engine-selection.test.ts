import { describe, it, expect, vi, beforeEach } from "vitest";
import { runCronJob } from "../runner.js";
import type { CronJob, Connector, JinnConfig } from "../../shared/types.js";

/**
 * The cron adapter used to materialize the employee and config engine
 * defaults into the route call, which reads downstream as "the caller named this
 * engine" and pins it. A cron fire whose engine is only a default then started on
 * an engine already known to be out of allowance, carrying its stale model.
 *
 * What the runner hands to route() is the seam: route() is where health orders a
 * preference, and it can only do that for a preference nobody stated outright.
 */

vi.mock("../jobs.js", () => ({ appendRunLog: vi.fn() }));
vi.mock("../../gateway/org-registry.js", () => ({ orgRegistry: vi.fn(() => new Map()) }));
vi.mock("../../work-items/store.js", () => ({ createWorkItem: vi.fn(() => ({ id: "wi_test" })), linkSession: vi.fn() }));
vi.mock("../../work-items/reconcile.js", () => ({ reconcileWorkItem: vi.fn() }));
vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return { id: "test-job", name: "Test Job", enabled: true, schedule: "0 * * * *", prompt: "do something", ...overrides };
}

/** Codex is the default engine and carries a configured model, as a real config does. */
function makeConfig(): JinnConfig {
  return {
    engines: { default: "codex", codex: { model: "gpt-5.6-sol", fallback: ["claude"] }, claude: { model: "opus" } },
    logging: { file: false, stdout: false, level: "info" },
    cron: {},
  } as unknown as JinnConfig;
}

function makeMockSessionManager() {
  return { route: vi.fn().mockResolvedValue({ sessionId: "sess-123" }) } as never;
}

const connectors = new Map<string, Connector>();

/** The options the runner handed to route() for this job. */
async function routeOptions(job: CronJob): Promise<Record<string, unknown>> {
  const sessionManager = makeMockSessionManager();
  await runCronJob(job, sessionManager, makeConfig(), connectors);
  return (sessionManager as unknown as { route: { mock: { calls: unknown[][] } } }).route.mock.calls[0]![2] as Record<string, unknown>;
}

beforeEach(() => vi.clearAllMocks());

describe("runCronJob — what the fire states about its engine", () => {
  it("states nothing when the job names no engine, leaving the default to route()", async () => {
    const opts = await routeOptions(makeJob());

    expect(opts["engine"]).toBeUndefined();
    expect(opts["model"]).toBeUndefined();
  });

  it("states the engine and model the job itself names", async () => {
    const opts = await routeOptions(makeJob({ engine: "codex", model: "gpt-5.6-sol" }));

    expect(opts["engine"]).toBe("codex");
    expect(opts["model"]).toBe("gpt-5.6-sol");
  });

  it("still passes the job's effort level, which is a per-fire override", async () => {
    const opts = await routeOptions(makeJob({ effortLevel: "high" }));

    expect(opts["effortLevel"]).toBe("high");
  });
});
