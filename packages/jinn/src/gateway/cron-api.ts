import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import type { CronJob, JinnConfig } from "../shared/types.js";
import { CRON_RUNS } from "../shared/paths.js";
import { ENGINE_NAMES, isKnownEngine } from "../shared/models.js";
import { isWalkEngine, runnerModelMatches, WALK_ENGINES } from "../board-walk/settings.js";
import { logger } from "../shared/logger.js";
import { canonicalCronJobId, loadJobs, saveJobs } from "../cron/jobs.js";
import { summarizeCronRun } from "../cron/run-summary.js";
import { reloadScheduler } from "../cron/scheduler.js";
import { validateCronSchedule } from "../cron/validation.js";
import { runCronJob } from "../cron/runner.js";
import { cronActionError } from "../cron/actions.js";
import { readJsonlTail } from "./jsonl-tail.js";
import { readJsonBody } from "./http-helpers.js";
import { badRequest, json, matchRoute, notFound, type ParsedRoute } from "./route-helpers.js";
import type { ApiContext } from "./api.js";

function cronJobSummary(job: Record<string, unknown>, lastRun: unknown): Record<string, unknown> {
  return {
    id: job.id,
    name: job.name,
    schedule: job.schedule,
    enabled: job.enabled !== false,
    employee: job.employee ?? null,
    engine: job.engine ?? null,
    timezone: job.timezone ?? null,
    action: job.action ?? null,
    lastRun: lastRun ? summarizeCronRun(lastRun) : null,
  };
}

/** Joined validation message, or null when the schedule is fine. */
function scheduleError(job: Pick<CronJob, "schedule" | "timezone">): string | null {
  const errors = validateCronSchedule({
    schedule: job.schedule,
    ...(job.timezone !== undefined ? { timezone: job.timezone } : {}),
  });
  return errors.length > 0 ? errors.map((entry) => entry.message).join("; ") : null;
}

/** Why an engine written on a board-walk job cannot be used, or null. Only an
 *  engine the walk can be confined on may be named; anything else would run the
 *  walk with an unbounded tool surface. */
function boardWalkEngineError(engine: string): string | null {
  if (!isKnownEngine(engine)) return `engine must be one of ${ENGINE_NAMES.join(", ")}`;
  if (!isWalkEngine(engine)) {
    return `the board walk can only run on ${WALK_ENGINES.join(" or ")}, so that its turn has only the walk's tools; "${engine}" cannot be confined to them`;
  }
  return null;
}

/**
 * Why a board-walk job's runner fields cannot be stored, or null. The walk's
 * `engine`/`model`/`employee`/`effortLevel` are honoured for this action (the
 * ordinary action job ignores them), so the engine must be one the walk can be
 * confined on, and the engine/model pair must match.
 */
function boardWalkRunnerError(job: CronJob, config: JinnConfig): string | null {
  if (job.action !== "board-walk") return null;
  const engine = job.engine?.trim();
  if (engine) {
    const problem = boardWalkEngineError(engine);
    if (problem) return problem;
  }
  const model = job.model?.trim();
  if (!model) return null;
  const target = engine || "claude";
  return runnerModelMatches(config, target, model) ? null : `model "${model}" is not supported by engine "${target}"`;
}

/** Why `job` cannot be stored, or null. */
function jobError(job: CronJob, config: JinnConfig): string | null {
  return scheduleError(job) ?? cronActionError(job) ?? boardWalkRunnerError(job, config);
}

/** Why a new job cannot join `jobs`: a built-in action runs from one job
 *  only, so a second job naming it would tick it twice. (An update cannot add
 *  a twin, since a job's action never changes; and it must stay free to
 *  switch off a hand-edited one.) */
function twinError(job: CronJob, jobs: CronJob[]): string | null {
  const twin = job.action ? jobs.find((other) => other.action === job.action) : undefined;
  return twin ? `the ${job.action} action already runs from cron job "${twin.id}"` : null;
}

async function listJobs(res: ServerResponse): Promise<void> {
  const jobs = loadJobs();
  // Enrich with last run status — tail-read only the newest entry, the
  // run logs are append-only JSONL that grows forever.
  const enriched = await Promise.all(jobs.map(async (job) => {
    const runFile = path.join(CRON_RUNS, `${job.id}.jsonl`);
    const { entries } = await readJsonlTail(runFile, 1);
    return cronJobSummary(job as unknown as Record<string, unknown>, entries[0] ?? null);
  }));
  json(res, enriched);
}

// Newest first (the UI shows "Recent Runs"). Run history is append-only JSONL
// that grows forever, so only the file's tail is read; corrupt lines (crash
// mid-write) are skipped, not 500'd.
async function listRuns(res: ServerResponse, id: string, url: URL): Promise<void> {
  const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get("limit") || "", 10) || 50));
  const runFile = path.join(CRON_RUNS, `${id}.jsonl`);
  const { entries: runs, skipped } = await readJsonlTail(runFile, limit);
  if (skipped) logger.warn(`GET /api/cron/${id}/runs: skipped ${skipped} corrupt line(s)`);
  json(res, runs.map(summarizeCronRun));
}

/** The job a create body describes, with the defaults this route has always applied. */
function jobFromBody(body: any): CronJob {
  return {
    id: body.id || crypto.randomUUID(),
    name: body.name || "untitled",
    enabled: body.enabled ?? true,
    schedule: body.schedule || "0 * * * *",
    timezone: body.timezone,
    engine: body.engine,
    model: body.model,
    employee: body.employee,
    prompt: body.prompt || "",
    delivery: body.delivery,
    ...(body.action !== undefined && body.action !== null ? { action: body.action } : {}),
  };
}

async function createJob(req: HttpRequest, res: ServerResponse, config: JinnConfig): Promise<void> {
  const _parsed = await readJsonBody(req, res);
  if (!_parsed.ok) return;
  const body = _parsed.body as any;
  const jobs = loadJobs();
  // Job ids are identity (run-log files and PUT/DELETE routing) —
  // a duplicate would double-schedule one id and collide two run histories in
  // one jsonl (Codex GRS-014d finding 2). Identity is CANONICAL (trim+lowercase,
  // GRS-014d-fix2): run-log files `<id>.jsonl` collide case-insensitively on the
  // default macOS volume, so differently-cased ids share the same job history.
  // Stored ids stay as authored; only the collision check (and a
  // padded-id rejection — whitespace ids break addressing) canonicalizes.
  if (typeof body.id === "string" && body.id !== body.id.trim()) {
    return badRequest(res, "cron job id must not have leading/trailing whitespace");
  }
  if (body.id && jobs.some((j) => canonicalCronJobId(j.id) === canonicalCronJobId(body.id))) {
    return badRequest(res, `a cron job with id "${body.id}" already exists`);
  }
  const newJob = jobFromBody(body);
  const invalid = jobError(newJob, config) ?? twinError(newJob, jobs);
  if (invalid) return badRequest(res, invalid);
  jobs.push(newJob);
  saveJobs(jobs);
  reloadScheduler(jobs);
  json(res, newJob, 201);
}

async function updateJob(req: HttpRequest, res: ServerResponse, id: string, config: JinnConfig): Promise<void> {
  const jobs = loadJobs();
  const idx = jobs.findIndex((j) => j.id === id);
  if (idx === -1) return notFound(res);
  const _parsed = await readJsonBody(req, res);
  if (!_parsed.ok) return;
  const merged = { ...jobs[idx], ...(_parsed.body as any), id } as CronJob;
  if (merged.action === null) delete merged.action;
  // What a job runs is fixed when it is made: an action job turned into a
  // prompt job would fire an empty prompt, and the reverse would drop one.
  if ((merged.action ?? null) !== (jobs[idx].action ?? null)) {
    return badRequest(res, "a cron job's action cannot be changed; create a new job instead");
  }
  const invalid = jobError(merged, config);
  if (invalid) return badRequest(res, invalid);
  jobs[idx] = merged;
  saveJobs(jobs);
  reloadScheduler(jobs);
  json(res, merged);
}

function deleteJob(res: ServerResponse, id: string): void {
  const jobs = loadJobs();
  const idx = jobs.findIndex((j) => j.id === id);
  if (idx === -1) return notFound(res);
  const removed = jobs.splice(idx, 1)[0];
  saveJobs(jobs);
  reloadScheduler(jobs);
  json(res, { deleted: removed.id, name: removed.name });
}

function triggerJob(res: ServerResponse, id: string, context: ApiContext): void {
  const job = loadJobs().find((j) => j.id === id);
  if (!job) return notFound(res);

  logger.info(`Manual trigger for cron job "${job.name}" (${job.id})`);

  // Fire and forget — respond immediately, run in background.
  runCronJob(job, context.sessionManager, context.getConfig(), context.connectors, { emit: context.emit, trigger: "manual" }).catch(
    (err) => logger.error(`Manual cron trigger failed for "${job.name}": ${err}`)
  );

  json(res, {
    triggered: true,
    jobId: job.id,
    name: job.name,
    employee: job.employee,
    message: `Cron job "${job.name}" triggered manually`,
  });
}

async function handleCronReads(res: ServerResponse, route: ParsedRoute): Promise<boolean> {
  const { method, pathname, url } = route;
  if (method !== "GET") return false;
  if (pathname === "/api/cron") {
    await listJobs(res);
    return true;
  }
  const runs = matchRoute("/api/cron/:id/runs", pathname);
  if (runs) {
    await listRuns(res, runs.id, url);
    return true;
  }
  return false;
}

/** Every route here is operator-only; api.ts gates them before delegating. */
async function handleCronWrites(
  req: HttpRequest,
  res: ServerResponse,
  route: ParsedRoute,
  context: ApiContext,
): Promise<boolean> {
  const { method, pathname } = route;
  if (method === "POST" && pathname === "/api/cron") {
    await createJob(req, res, context.getConfig());
    return true;
  }
  const job = matchRoute("/api/cron/:id", pathname);
  if (method === "PUT" && job) {
    await updateJob(req, res, job.id, context.getConfig());
    return true;
  }
  if (method === "DELETE" && job) {
    deleteJob(res, job.id);
    return true;
  }
  const trigger = matchRoute("/api/cron/:id/trigger", pathname);
  if (method === "POST" && trigger) {
    triggerJob(res, trigger.id, context);
    return true;
  }
  return false;
}

/** `/api/cron*` routes. See route-helpers.ts for the domain-module contract. */
export async function handleCronApi(
  req: HttpRequest,
  res: ServerResponse,
  route: ParsedRoute,
  context: ApiContext,
): Promise<boolean> {
  return (await handleCronReads(res, route)) || (await handleCronWrites(req, res, route, context));
}
