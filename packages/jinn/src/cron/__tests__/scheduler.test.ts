import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CronJob, JinnConfig, Connector } from "../../shared/types.js";

// Capture the callback node-cron would invoke on a scheduled tick so we can fire it
// manually. cron.schedule/validate are stubbed; stopScheduler needs a `.stop()`.
let scheduledCallback: (() => void) | undefined;
let throwExpression: string | undefined;
type ScheduleOpts = { timezone?: string; recoverMissedExecutions?: boolean; scheduled?: boolean };
const scheduledTasks: Array<{ expression: string; opts?: ScheduleOpts; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = [];
vi.mock("node-cron", () => ({
  default: {
    schedule: vi.fn((expr: string, cb: () => void, opts?: ScheduleOpts) => {
      if (opts?.timezone === "Mars/Olympus" || expr === throwExpression) throw new RangeError("Invalid time zone specified");
      scheduledCallback = cb;
      const task = { expression: expr, opts, start: vi.fn(), stop: vi.fn() };
      scheduledTasks.push(task);
      return task;
    }),
    validate: vi.fn(() => true),
  },
}));

// Stub the runner so we assert HOW it is invoked, not what it does.
vi.mock("../runner.js", () => ({ runCronJob: vi.fn().mockResolvedValue(undefined) }));

const job: CronJob = {
  id: "test-job",
  name: "Test Job",
  enabled: true,
  schedule: "0 * * * *",
  prompt: "do something",
};

// findJob() loads jobs from disk — stub loadJobs to return our fixture.
vi.mock("../jobs.js", () => ({
  loadJobs: vi.fn(() => [job]),
  saveJobs: vi.fn(),
}));

vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { armedActionJob, reloadScheduler, startScheduler, stopScheduler, triggerCronJob } from "../scheduler.js";
import { runCronJob } from "../runner.js";

const sessionManager = {} as any;
const baseConfig = { engines: { default: "claude" } } as unknown as JinnConfig;
let config = baseConfig;
const connectors = new Map<string, Connector>();
const deps = { sessionManager, getConfig: () => config, connectors };

// A scheduled fire is deferred one loop turn so catch-up emissions coalesce; let
// the queued setImmediate run before asserting the runner was invoked.
const flushScheduledFire = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  stopScheduler();
  vi.clearAllMocks();
  scheduledCallback = undefined;
  throwExpression = undefined;
  scheduledTasks.length = 0;
  config = baseConfig;
});

describe("scheduler — manual vs scheduled fire identity (GRS-003b-1)", () => {
  it("triggerCronJob (manual /cron run) passes NO fireIso and reads the live config", async () => {
    startScheduler([], deps); // capture deps, schedule nothing
    const swapped = { engines: { default: "codex" } } as unknown as JinnConfig;
    config = swapped;

    const result = await triggerCronJob("test-job");

    expect(result).toEqual(job);
    expect(runCronJob).toHaveBeenCalledTimes(1);
    const call = (runCronJob as any).mock.calls[0];
    // PLA-260: the config reaching the runner is the one the gateway holds NOW,
    // not the one that existed when the scheduler was started.
    expect(call[2]).toBe(swapped);
    // The opts carry the workflow fire handler slot (GRS-014d) but NO fireIso — a manual
    // trigger is a fresh fire by definition, so it never reuses a scheduled tick's identity.
    expect(call[4]?.fireIso).toBeUndefined();
  });

  it("a scheduled tick passes a deterministic per-fire fireIso and reads the live config", async () => {
    startScheduler([job], deps); // schedules the job, captures cb
    expect(scheduledCallback).toBeTypeOf("function");
    // A missed-execution ticker is armed so a skipped scheduled second is recovered.
    expect(scheduledTasks[0]!.opts).toMatchObject({ scheduled: false, recoverMissedExecutions: true });
    const swapped = { engines: { default: "codex" } } as unknown as JinnConfig;
    config = swapped;

    scheduledCallback!(); // simulate node-cron firing the tick
    await flushScheduledFire();

    expect(runCronJob).toHaveBeenCalledTimes(1);
    const call = (runCronJob as any).mock.calls[0];
    expect(call[2]).toBe(swapped); // PLA-260: resolved at fire time, not capture time
    const opts = call[4];
    expect(opts).toBeDefined();
    expect(opts.fireIso).toMatch(/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/);
  });

  it("reload skips an invalid job and schedules the valid ones", () => {
    startScheduler([job], deps);
    const oldTask = scheduledTasks[0];
    throwExpression = "5 * * * *";
    const invalid = { ...job, id: "bad", schedule: throwExpression };
    const valid = { ...job, id: "replacement" };

    expect(reloadScheduler([invalid, valid])).toEqual({ scheduled: 1, skipped: 1 });

    expect(oldTask.stop).toHaveBeenCalled();
    expect(scheduledTasks).toHaveLength(2); // boot task + valid replacement
  });

});

describe("scheduler — a job that runs a built-in action", () => {
  const walk: CronJob = { id: "board-walk", name: "Board walk", enabled: true, schedule: "0 * * * *", prompt: "", action: "board-walk" };

  it("a scheduled fire tells the runner it is a scheduled fire", async () => {
    startScheduler([walk], deps);
    scheduledCallback!();
    await flushScheduledFire();
    const call = (runCronJob as any).mock.calls[0];
    expect(call[0]).toBe(walk);
    expect(call[4]).toMatchObject({ trigger: "schedule" });
  });

  it("schedules one job per action, so a hand-edited copy cannot tick it twice", () => {
    const copy = { ...walk, id: "board-walk-copy", name: "Board walk copy" };
    const off = { ...walk, id: "board-walk-off", enabled: false };
    expect(reloadScheduler([off, walk, copy, job])).toEqual({ scheduled: 2, skipped: 1 });
    expect(scheduledTasks).toHaveLength(2);
  });

  it("an empty name does not let a second job slip past the one-per-action guard", () => {
    const nameless = { ...walk, name: "" };
    const copy = { ...walk, id: "board-walk-copy", name: "copy" };
    expect(reloadScheduler([nameless, copy])).toEqual({ scheduled: 1, skipped: 1 });
    expect(armedActionJob("board-walk")).toBe(nameless);
  });

  it("reports the job it armed, skipping one that does not validate, and none once stopped", () => {
    throwExpression = "61 * * * *";
    const broken = { ...walk, id: "broken", schedule: throwExpression };
    const second = { ...walk, id: "second" };
    expect(reloadScheduler([broken, second])).toEqual({ scheduled: 1, skipped: 1 });
    expect(armedActionJob("board-walk")).toBe(second);
    reloadScheduler([{ ...walk, enabled: false }]);
    expect(armedActionJob("board-walk")).toBeUndefined();
    reloadScheduler([walk]);
    stopScheduler();
    expect(armedActionJob("board-walk")).toBeUndefined();
  });

  it("skips a job naming an action the gateway does not have", () => {
    expect(reloadScheduler([{ ...walk, action: "launch" as never }])).toEqual({ scheduled: 0, skipped: 1 });
  });
});
