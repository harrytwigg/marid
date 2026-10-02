import type { CronAction, CronJob } from "../shared/types.js";
import type { GatewayEmit } from "../shared/gateway-events.js";
import { logger } from "../shared/logger.js";
import { appendRunLog } from "./jobs.js";

/**
 * Built-in cron actions: a job with `action` set runs a piece of the gateway
 * instead of routing a prompt to an engine session. It is scheduled, run now,
 * enabled, disabled and listed like any other job, and each fire is written to
 * the same run history. What it does not do is mint a Todo per fire or send the
 * cron failure alert: the action keeps its own record (the board walk has its
 * tick log), and an hourly action that cannot run would otherwise alert hourly.
 *
 * The gateway registers each action's handler once the thing it drives is up.
 * A fire with no handler is recorded as a failed run, not dropped.
 */

export const CRON_ACTIONS: readonly CronAction[] = ["board-walk"];

export function isCronAction(value: unknown): value is CronAction {
  return typeof value === "string" && (CRON_ACTIONS as readonly string[]).includes(value);
}

/** Why a job's `action` field is unusable, or null when it is absent or known. */
export function cronActionError(job: Pick<CronJob, "action">): string | null {
  if (job.action === undefined || isCronAction(job.action)) return null;
  return `action must be one of ${CRON_ACTIONS.join(", ")}`;
}

/** A scheduled fire, or a person's run-now (HTTP, the `/cron run` command). */
export type CronActionTrigger = "schedule" | "manual";

export interface CronActionResult {
  status: "success" | "error";
  /** One line for the gateway log. */
  summary: string;
  /** A session the action ran, linked from the run history. */
  sessionId?: string;
  error?: string;
}

export type CronActionHandler = (job: CronJob, trigger: CronActionTrigger) => Promise<CronActionResult>;

const handlers = new Map<CronAction, CronActionHandler>();

/** Register (or, with null, remove) the handler an action's fires call. */
export function setCronActionHandler(action: CronAction, handler: CronActionHandler | null): void {
  if (handler) handlers.set(action, handler);
  else handlers.delete(action);
}

export interface RunActionJobOptions {
  trigger: CronActionTrigger;
  emit?: GatewayEmit;
}

async function callHandler(job: CronJob & { action: CronAction }, trigger: CronActionTrigger): Promise<CronActionResult> {
  const handler = handlers.get(job.action);
  if (!handler) {
    const error = `the ${job.action} action is not available in this gateway`;
    return { status: "error", summary: error, error };
  }
  try {
    return await handler(job, trigger);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { status: "error", summary: `crashed: ${error}`, error };
  }
}

export async function runActionJob(job: CronJob & { action: CronAction }, opts: RunActionJobOptions): Promise<void> {
  const startTime = Date.now();
  logger.info(`Cron job "${job.name}" (${job.id}) starting the ${job.action} action (${opts.trigger})`);
  const result = await callHandler(job, opts.trigger);
  const durationMs = Date.now() - startTime;
  appendRunLog(job.id, {
    timestamp: new Date(startTime).toISOString(),
    sessionId: result.sessionId ?? null,
    status: result.status,
    durationMs,
    error: result.status === "error" ? result.error ?? result.summary : null,
    trigger: opts.trigger,
  });
  opts.emit?.("cron:run-finished", { jobId: job.id, status: result.status });
  const line = `Cron job "${job.name}" (${job.action}) ${result.status === "success" ? "completed" : "failed"} in ${durationMs}ms: ${result.summary}`;
  if (result.status === "success") logger.info(line);
  else logger.warn(line);
}
