import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import cron from "node-cron";
import type { CronJob, JinnConfig, Connector } from "../../shared/types.js";

// This file drives the REAL node-cron scheduler under fake timers — the point is
// the ticker's own missed-second behaviour, so there is no node-cron mock here.

vi.mock("../runner.js", () => ({ runCronJob: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../jobs.js", () => ({ loadJobs: vi.fn(() => []), saveJobs: vi.fn() }));

import { startScheduler, stopScheduler } from "../scheduler.js";
import { runCronJob } from "../runner.js";
import { logger } from "../../shared/logger.js";

const job = (schedule: string): CronJob => ({
  id: "catchup-job",
  name: "Catchup Job",
  enabled: true,
  schedule,
  prompt: "do something",
});

const sessionManager = {} as any;
const config = { engines: { default: "claude" } } as unknown as JinnConfig;
const connectors = new Map<string, Connector>();
const deps = { sessionManager, getConfig: () => config, connectors };

// The real scheduled fire is deferred one loop turn so catch-up emissions
// coalesce; setImmediate is left real, so flush it before asserting.
const flushFire = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "hrtime"],
  });
});

afterEach(() => {
  stopScheduler();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("scheduler — missed-execution recovery and coalescing", () => {
  it("arms every task with recoverMissedExecutions", () => {
    vi.setSystemTime(new Date("2026-01-01T12:00:30.000Z"));
    const scheduleSpy = vi.spyOn(cron, "schedule");
    startScheduler([job("0 * * * *")], deps);
    const opts = scheduleSpy.mock.calls[0]?.[2] as Record<string, unknown> | undefined;
    scheduleSpy.mockRestore();
    expect(opts).toMatchObject({ scheduled: false, recoverMissedExecutions: true });
  });

  it("fires an ordinary on-time schedule exactly once, with no same-second re-emit", async () => {
    // Recovery makes node-cron re-test the previous second on every tick; an
    // untruncated ms on `now - 1000` re-matches the second that just fired. The
    // ticker must run the slot once even as later ticks pass over it.
    vi.setSystemTime(new Date("2026-01-01T11:59:58.500Z"));
    startScheduler([job("0 * * * *")], deps);

    for (let i = 0; i < 5; i += 1) {
      vi.advanceTimersByTime(1000);
      await flushFire();
    }

    expect(runCronJob).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("recovers a :00 fire the delayed ticker skipped, exactly once", async () => {
    // node-cron ticks every ~1000ms from its own phase. A tick that lands at :01
    // instead of :00 tests only the current second and drops an hourly fire. Model
    // that by letting a timer due before the next check jump the wall clock past
    // the boundary, so the check lands after it.
    vi.setSystemTime(new Date("2026-01-01T11:59:59.900Z"));
    startScheduler([job("0 * * * *")], deps);
    setTimeout(() => vi.setSystemTime(new Date("2026-01-01T12:00:01.000Z")), 500);

    vi.advanceTimersByTime(1100);
    await flushFire();
    // Later ticks must not re-fire the recovered slot.
    for (let i = 0; i < 3; i += 1) {
      vi.advanceTimersByTime(1000);
      await flushFire();
    }

    expect(runCronJob).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("coalesces a burst of catch-up emissions into one fire and warns", async () => {
    // When node-cron recovers, it emits once per matching second synchronously
    // inside a single matchTime loop. Drive that burst directly: three emissions
    // in one turn must run the job once and report the collapse.
    vi.setSystemTime(new Date("2026-01-01T12:00:30.000Z"));
    const scheduleSpy = vi.spyOn(cron, "schedule");
    startScheduler([job("* * * * *")], deps);
    const fire = scheduleSpy.mock.calls[0]?.[1] as ((now: Date) => void) | undefined;
    scheduleSpy.mockRestore();

    // Distinct missed slots, emitted synchronously in one catch-up loop.
    fire!(new Date("2026-01-01T11:58:00.000Z"));
    fire!(new Date("2026-01-01T11:59:00.000Z"));
    fire!(new Date("2026-01-01T12:00:00.000Z"));
    await flushFire();

    expect(runCronJob).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect((logger.warn as any).mock.calls[0]![0]).toMatch(/coalesced/);
  });

  it("does not replay a fire missed while the scheduler was stopped", async () => {
    vi.setSystemTime(new Date("2026-01-01T11:00:30.000Z"));
    startScheduler([job("0 * * * *")], deps);
    stopScheduler();

    // Two hours pass with nothing scheduled; restarting must not backfill 12:00.
    vi.setSystemTime(new Date("2026-01-01T13:00:30.000Z"));
    startScheduler([job("0 * * * *")], deps);
    await flushFire();

    expect(runCronJob).not.toHaveBeenCalled();
  });
});
