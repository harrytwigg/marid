import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CronJob } from "../../shared/types.js";

vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

// CRON_JOBS is resolved at module load from JINN_HOME, so point it at a temp dir
// and re-import the module graph per test (same pattern as jobs.test.ts).
let tmpHome: string;
const prevHome = process.env.JINN_HOME;

beforeEach(() => {
  vi.clearAllMocks();
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-cron-retired-"));
  process.env.JINN_HOME = tmpHome;
  vi.resetModules();
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.JINN_HOME;
  else process.env.JINN_HOME = prevHome;
  vi.resetModules();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

const job = (id: string, name = "Job"): CronJob => ({
  id, name, enabled: true, schedule: "0 * * * *", prompt: "do something",
});

async function load() {
  const jobs = await import("../jobs.js");
  const retired = await import("../retired-jobs.js");
  const { logger } = await import("../../shared/logger.js");
  return { ...jobs, ...retired, logger };
}

describe("removeRetiredExperimentCheckInJobs", () => {
  it("removes only the experiment check-in jobs from a mixed list", async () => {
    const { loadJobs, saveJobs, removeRetiredExperimentCheckInJobs, logger } = await load();
    const keep = [
      job("daily-digest"),
      job("experiment-check-in"),
      job("experiment-check-in-exp_abc"),
      job("experiment-check-in-exp_0123456789abcdef"),
      job("experiment-check-in-exp_0123456789ag"),
      job("my-experiment-check-in-exp_0123456789ab"),
      job("experiment-check-in-exp_0123456789ab-extra"),
      job("weekly-report", "Experiment check-in: looks similar but is not generated"),
    ];
    saveJobs([
      keep[0],
      job("experiment-check-in-exp_0123456789ab", "Experiment check-in: Onboarding"),
      ...keep.slice(1, 4),
      job("Experiment-Check-In-EXP_0123456789AB"),
      ...keep.slice(4),
      job("experiment-check-in-exp_ffffffffffff"),
    ]);

    expect(removeRetiredExperimentCheckInJobs()).toBe(3);

    expect(loadJobs()).toEqual(keep);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("Removed 3"));
  });

  it("does not rewrite jobs.json when nothing matches", async () => {
    const { saveJobs, removeRetiredExperimentCheckInJobs, logger } = await load();
    saveJobs([job("daily-digest")]);
    const file = path.join(tmpHome, "cron", "jobs.json");
    const before = fs.statSync(file).mtimeMs;
    const content = fs.readFileSync(file, "utf-8");

    expect(removeRetiredExperimentCheckInJobs()).toBe(0);

    expect(fs.readFileSync(file, "utf-8")).toBe(content);
    expect(fs.statSync(file).mtimeMs).toBe(before);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("is a no-op when there is no jobs file", async () => {
    const { removeRetiredExperimentCheckInJobs } = await load();
    expect(removeRetiredExperimentCheckInJobs()).toBe(0);
    expect(fs.existsSync(path.join(tmpHome, "cron", "jobs.json"))).toBe(false);
  });

  it("is idempotent", async () => {
    const { saveJobs, removeRetiredExperimentCheckInJobs } = await load();
    saveJobs([job("experiment-check-in-exp_0123456789ab"), job("daily-digest")]);
    expect(removeRetiredExperimentCheckInJobs()).toBe(1);
    expect(removeRetiredExperimentCheckInJobs()).toBe(0);
  });
});
