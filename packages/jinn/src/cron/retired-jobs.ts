import { logger } from "../shared/logger.js";
import { canonicalCronJobId, loadJobs, saveJobs } from "./jobs.js";

/**
 * The removed Experiments feature registered one cron job per check-in, with an
 * id of exactly this shape. Nothing else writes ids like it, so a match is
 * unambiguous and the job can only call tools that no longer exist.
 */
const EXPERIMENT_CHECK_IN_JOB_ID = /^experiment-check-in-exp_[0-9a-f]{12}$/;

/**
 * Remove the orphaned Experiments check-in jobs from jobs.json. Idempotent, and
 * rewrites the file only when something matched. Every other job is left as is.
 * Returns the number of jobs removed.
 */
export function removeRetiredExperimentCheckInJobs(): number {
  const jobs = loadJobs();
  const kept = jobs.filter((job) => !EXPERIMENT_CHECK_IN_JOB_ID.test(canonicalCronJobId(job.id)));
  const removed = jobs.length - kept.length;
  if (removed === 0) return 0;
  saveJobs(kept);
  logger.info(`Removed ${removed} orphaned experiment check-in cron job(s)`);
  return removed;
}
