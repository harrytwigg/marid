import fs from "node:fs";
import path from "node:path";
import type { CronJob } from "../shared/types.js";
import { CRON_JOBS, CRON_RUNS } from "../shared/paths.js";
import { logger } from "../shared/logger.js";

export function loadJobs(): CronJob[] {
  let raw: string;
  try {
    raw = fs.readFileSync(CRON_JOBS, "utf-8");
  } catch (err) {
    // Missing file is normal (no cron jobs configured yet); anything else is not.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.error(
        `Failed to read cron jobs file ${CRON_JOBS}: ${err instanceof Error ? err.message : err}`,
      );
    }
    return [];
  }
  try {
    return JSON.parse(raw) as CronJob[];
  } catch (err) {
    // Corrupt JSON: preserve the broken file for the operator, then run with no jobs.
    const backupPath = `${CRON_JOBS}.corrupt-${Date.now()}`;
    try {
      fs.copyFileSync(CRON_JOBS, backupPath);
    } catch {
      // best effort — the original file is still on disk
    }
    logger.error(
      `Failed to parse cron jobs file ${CRON_JOBS}: ${err instanceof Error ? err.message : err}. ` +
      `Corrupt copy saved to ${backupPath}; running with zero cron jobs.`,
    );
    return [];
  }
}

export function saveJobs(jobs: CronJob[]): void {
  const dir = path.dirname(CRON_JOBS);
  fs.mkdirSync(dir, { recursive: true });
  // Atomic write: tmp file + rename so a crash mid-write can't corrupt jobs.json.
  const tmpPath = `${CRON_JOBS}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(jobs, null, 2) + "\n", "utf-8");
  fs.renameSync(tmpPath, CRON_JOBS);
}

/**
 * Canonical cron-job identity for collision checks. Run-log files are
 * `<id>.jsonl` under CRON_RUNS and the default
 * macOS volume is case-insensitive, so ids differing only by case (or by
 * leading/trailing whitespace) share ONE run-history file — a filesystem
 * constraint the code cannot otherwise show. Identity therefore compares
 * trimmed + lowercased. Storage is untouched: jobs keep their authored id
 * everywhere; only collision comparisons canonicalize. Unicode is
 * NFC-normalized first: macOS additionally treats NFC/NFD
 * variants of one name as the same file, so composed vs decomposed ids would
 * also share a run history.
 */
export function canonicalCronJobId(id: string): string {
  return id.trim().normalize("NFC").toLowerCase();
}

export function appendRunLog(jobId: string, entry: object): void {
  fs.mkdirSync(CRON_RUNS, { recursive: true });
  const logPath = path.join(CRON_RUNS, `${jobId}.jsonl`);
  fs.appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");
}
