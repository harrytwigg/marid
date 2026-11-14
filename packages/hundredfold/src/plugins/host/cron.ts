import path from "node:path";
import { loadJobs } from "../../cron/jobs.js";
import { summarizeCronRun } from "../../cron/run-summary.js";
import { readJsonlTail } from "../../gateway/jsonl-tail.js";
import { CRON_RUNS } from "../../shared/paths.js";
import { assertVerbAllowed } from "./permissions.js";

/** A cron job as the read tier exposes it. The prompt, the model and the
 *  delivery target are deliberately absent, exactly as they are from
 *  `GET /api/cron` — a plugin that can list jobs is not thereby able to read
 *  what they say. */
export interface PluginCronJob {
  id: string;
  name: string;
  schedule: string;
  enabled: boolean;
  employee: string | null;
  engine: string | null;
  timezone: string | null;
}

export interface PluginHostCron {
  jobs(): PluginCronJob[];
  /** The most recent runs of one job, newest first. */
  runs(jobId: string, limit?: number): Promise<Record<string, unknown>[]>;
}

/** The same clamp `GET /api/cron/:id/runs` applies, so a plugin cannot ask the
 *  tail reader for an unbounded slice of an append-only log. */
const MAX_RUNS = 500;
const DEFAULT_RUNS = 20;

export function cronVerbs(pluginId: string): PluginHostCron {
  return {
    jobs() {
      assertVerbAllowed(pluginId, "cron.jobs");
      return loadJobs().map((job) => ({
        id: job.id,
        name: job.name,
        schedule: job.schedule,
        enabled: job.enabled !== false,
        employee: job.employee ?? null,
        engine: job.engine ?? null,
        timezone: job.timezone ?? null,
      }));
    },
    async runs(jobId, limit = DEFAULT_RUNS) {
      assertVerbAllowed(pluginId, "cron.runs");
      const bounded = Math.min(MAX_RUNS, Math.max(1, Math.trunc(limit) || DEFAULT_RUNS));
      // The same summariser the route uses, so a run log's prompt, output and
      // error text stay out of a plugin's hands here too.
      const { entries } = await readJsonlTail(path.join(CRON_RUNS, `${jobId}.jsonl`), bounded);
      return entries.map(summarizeCronRun);
    },
  };
}
