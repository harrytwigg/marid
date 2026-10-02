import cron from "node-cron";
import type {
  CronAction,
  CronJob,
  JinnConfig,
  Connector,
} from "../shared/types.js";
import { runCronJob } from "./runner.js";
import { logger } from "../shared/logger.js";
import type { SessionManager } from "../sessions/manager.js";
import type { GatewayEmit } from "../shared/gateway-events.js";
import { loadJobs, saveJobs } from "./jobs.js";
import { validateCronSchedule } from "./validation.js";
import { cronActionError } from "./actions.js";

type SchedulerDeps = {
  sessionManager: SessionManager;
  getConfig: () => JinnConfig;
  connectors: Map<string, Connector>;
  emit?: GatewayEmit;
};

let tasks: cron.ScheduledTask[] = [];
let deps: SchedulerDeps;
/** The job each built-in action is armed from, as of the last reload. */
let armedActions = new Map<CronAction, CronJob>();

/** The job the scheduler armed for `action`, or undefined when none is armed
 *  (no job, all disabled, or none valid). This is the job that fires. */
export function armedActionJob(action: CronAction): CronJob | undefined {
  return armedActions.get(action);
}

export function startScheduler(jobs: CronJob[], schedulerDeps: SchedulerDeps): void {
  deps = schedulerDeps;
  reloadScheduler(jobs);
}

export function reloadScheduler(jobs: CronJob[]): { scheduled: number; skipped: number } {
  const started: cron.ScheduledTask[] = [];
  let skipped = 0;
  // A built-in action is scheduled once: a second enabled job naming the same
  // action (a hand-edited copy) would tick it twice, so it is skipped.
  const armed = new Map<CronAction, CronJob>();
  for (const job of jobs) {
    if (!job.enabled) continue;
    const first = job.action ? armed.get(job.action) : undefined;
    if (first) {
      skipped += 1;
      logger.warn(`Skipping cron job "${job.name}" (${job.id}): the ${job.action} action is already scheduled by "${first.id}"`);
      continue;
    }
    try {
      const task = createTask(job);
      task.start();
      started.push(task);
      if (job.action) armed.set(job.action, job);
      logger.info(`Scheduled cron job "${job.name}" (${job.schedule})`);
    } catch (err) {
      skipped += 1;
      logger.warn(`Skipping invalid cron job "${job.name}": ${err instanceof Error ? err.message : err}`);
    }
  }
  for (const task of tasks) task.stop();
  tasks = started;
  armedActions = armed;
  return { scheduled: started.length, skipped };
}

export function stopScheduler(): void {
  for (const task of tasks) {
    task.stop();
  }
  tasks = [];
  armedActions = new Map();
}

function createTask(job: CronJob): cron.ScheduledTask {
  const validation = validateCronSchedule({ schedule: job.schedule, ...(job.timezone !== undefined ? { timezone: job.timezone } : {}) });
  if (validation.length > 0) {
    throw new Error(validation.map((entry) => entry.message).join('; '));
  }
  const actionError = cronActionError(job);
  if (actionError) throw new Error(actionError);
  return cron.schedule(
    job.schedule,
    () => {
      // Capture the fire identity once, at fire time, so it's owned by this fire
      // (not recomputed inside runCronJob) and names the same session/work-item/link
      // on any re-invocation of this fire (GRS-003b-1).
      const fireIso = new Date().toISOString();
      runCronJob(job, deps.sessionManager, deps.getConfig(), deps.connectors, { fireIso, emit: deps.emit, trigger: "schedule" }).catch((err) => {
        logger.error(`Cron job "${job.name}" crashed: ${err instanceof Error ? err.message : err}`);
      });
    },
    { timezone: job.timezone, scheduled: false },
  );
}

export async function triggerCronJob(idOrName: string): Promise<CronJob | undefined> {
  const job = findJob(idOrName);
  if (!job) return undefined;
  // Manual `/cron run <job>` is a human "run it now" — like the gateway's HTTP
  // run-now (api.ts), it passes NO `fireIso`. Each manual trigger is a fresh fire
  // (runner defaults to a new per-call ISO). Only the scheduled TICK carries a
  // deterministic per-fire identity (GRS-003b-1).
  await runCronJob(job, deps.sessionManager, deps.getConfig(), deps.connectors, { emit: deps.emit });
  return job;
}

export function setCronJobEnabled(idOrName: string, enabled: boolean): CronJob | undefined {
  const jobs = loadJobs();
  const index = jobs.findIndex((job) => matchesJob(job, idOrName));
  if (index === -1) return undefined;
  jobs[index] = { ...jobs[index], enabled };
  saveJobs(jobs);
  reloadScheduler(jobs);
  return jobs[index];
}

function findJob(idOrName: string): CronJob | undefined {
  return loadJobs().find((job) => matchesJob(job, idOrName));
}

function matchesJob(job: CronJob, idOrName: string): boolean {
  const needle = idOrName.trim().toLowerCase();
  return job.id.toLowerCase() === needle || job.name.toLowerCase() === needle;
}
