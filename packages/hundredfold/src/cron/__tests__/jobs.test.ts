import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CronJob } from "../../shared/types.js";

// Stub logger so tests don't touch the real log files
vi.mock("../../shared/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

// CRON_JOBS is resolved at module load from process.env.HUNDREDFOLD_HOME, so we point
// it at a temp dir and re-import the module graph per test (same pattern as
// the context.ts tests).
let tmpHome: string;
const prevHome = process.env.HUNDREDFOLD_HOME;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-cron-jobs-"));
  process.env.HUNDREDFOLD_HOME = tmpHome;
  vi.resetModules();
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HUNDREDFOLD_HOME;
  else process.env.HUNDREDFOLD_HOME = prevHome;
  vi.resetModules();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function importJobs() {
  const jobs = await import("../jobs.js");
  const { logger } = await import("../../shared/logger.js");
  return { ...jobs, logger };
}

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "test-job",
    name: "Test Job",
    enabled: true,
    schedule: "0 * * * *",
    prompt: "do something",
    ...overrides,
  };
}

describe("loadJobs", () => {
  it("returns [] silently when jobs.json is missing", async () => {
    const { loadJobs, logger } = await importJobs();
    expect(loadJobs()).toEqual([]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("logs an error and backs up the corrupt file on parse failure", async () => {
    const cronDir = path.join(tmpHome, "cron");
    fs.mkdirSync(cronDir, { recursive: true });
    const jobsPath = path.join(cronDir, "jobs.json");
    fs.writeFileSync(jobsPath, "{ not valid json", "utf-8");

    const { loadJobs, logger } = await importJobs();
    expect(loadJobs()).toEqual([]);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(logger.error).mock.calls[0][0])).toContain("Failed to parse");

    // Corrupt copy is preserved next to the original
    const backups = fs.readdirSync(cronDir).filter((f) => f.startsWith("jobs.json.corrupt-"));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(cronDir, backups[0]), "utf-8")).toBe("{ not valid json");
    // Original file is left in place
    expect(fs.existsSync(jobsPath)).toBe(true);
  });
});

describe("saveJobs", () => {
  it("round-trips jobs through loadJobs and leaves no tmp file behind", async () => {
    const { loadJobs, saveJobs } = await importJobs();
    const jobs = [makeJob(), makeJob({ id: "other-job", name: "Other Job", enabled: false })];

    saveJobs(jobs);
    expect(loadJobs()).toEqual(jobs);

    const cronDir = path.join(tmpHome, "cron");
    const leftovers = fs.readdirSync(cronDir).filter((f) => f.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });
});

describe("appendRunLog", () => {
  it("appends each entry verbatim as its own JSON line in the job's .jsonl", async () => {
    const { appendRunLog } = await importJobs();
    const first = { timestamp: "2026-07-01T06:00:00.000Z", sessionKey: "cron:rt-job:a", status: "success" };
    const second = { timestamp: "2026-07-01T07:00:00.000Z", sessionKey: "cron:rt-job:b", status: "error" };

    appendRunLog("rt-job", first);
    appendRunLog("rt-job", second);

    const raw = fs.readFileSync(path.join(tmpHome, "cron", "runs", "rt-job.jsonl"), "utf-8");
    expect(raw.trim().split("\n").map((line) => JSON.parse(line))).toEqual([first, second]);
  });
});

describe("canonicalCronJobId (GRS-014d-fix2/3) — filesystem-identity canonicalization", () => {
  it("treats case, padding, and NFC/NFD unicode variants as one identity (they share one run-log file on macOS)", async () => {
    const { canonicalCronJobId } = await import("../jobs.js");
    expect(canonicalCronJobId("Workflow:WF-A")).toBe("workflow:wf-a");
    expect(canonicalCronJobId(" workflow:wf-a ")).toBe("workflow:wf-a");
    // NFC \u00e9 ("é" precomposed) vs NFD "e" + combining acute (\u0065\u0301):
    // different JS strings, ONE file name on macOS — must be one identity.
    const nfc = "workflow:caf\u00e9";
    const nfd = "workflow:cafe\u0301";
    expect(nfc).not.toBe(nfd); // sanity: the inputs really differ pre-canonicalization
    expect(canonicalCronJobId(nfc)).toBe(canonicalCronJobId(nfd));
    // Combined with case drift on the composed char.
    expect(canonicalCronJobId("Workflow:CAF\u00c9")).toBe(canonicalCronJobId(nfd));
  });
});
