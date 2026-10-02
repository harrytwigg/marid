import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import yaml from "js-yaml";
import type { CronJob } from "../shared/types.js";
import { validateCronSchedule } from "../cron/validation.js";
import type { CronActionHandler, CronActionResult } from "../cron/actions.js";
import { BOARD_WALK_FILE, RETIRED_SCHEDULE_KEYS, boardWalkPath, frontmatterMapping, frontmatterSpan } from "./settings.js";
import type { TickRecord } from "./store.js";

/**
 * The board walk's schedule is an ordinary cron job: `board-walk` in
 * `cron/jobs.json`, with `action: "board-walk"`. The cron scheduler fires it, the
 * cron controls run it now, change its schedule and switch it off, and each fire
 * lands in the job's run history beside the walk's own tick log. The gateway has
 * no other timer for the walk.
 *
 *   - **Seeded once.** A fresh install gets the job at `jinn setup` or first
 *     boot. An upgrade gets it built from `board-walk.md`'s old `enabled`,
 *     `schedule` and `timezone`, which are then taken out of the frontmatter (a
 *     copy of the file is kept), so the schedule lives in one place.
 *   - **Disable to stop it.** A disabled job is not scheduled; run-now still
 *     ticks once, as it does for any disabled job.
 *   - **Delete means gone.** A marker records that the job was seeded, so a
 *     deleted job is not re-created at the next boot: the walk then runs only
 *     when started by hand. To bring it back, create a cron job with
 *     `action: "board-walk"`.
 *   - **One job runs it.** The cron API refuses a second job with the action,
 *     and the scheduler skips a hand-edited second one, so the walk never ticks
 *     twice. A tick already running when a fire lands is skipped, never stacked.
 */

export const BOARD_WALK_JOB_ID = "board-walk";
export const BOARD_WALK_JOB_NAME = "Board walk";
export const BOARD_WALK_DEFAULT_SCHEDULE = "0 * * * *";
const MARKER_FILE = path.join("state", "board-walk-job.json");

/** The job that schedules the walk: the first enabled one with the action,
 *  which is the one the scheduler arms, or else the first one at all. */
export function findBoardWalkJob(jobs: readonly CronJob[]): CronJob | undefined {
  const walks = jobs.filter((job) => job.action === "board-walk");
  return walks.find((job) => job.enabled) ?? walks[0];
}

export function boardWalkJob(schedule: { enabled: boolean; schedule: string; timezone?: string }): CronJob {
  return {
    id: BOARD_WALK_JOB_ID,
    name: BOARD_WALK_JOB_NAME,
    enabled: schedule.enabled,
    schedule: schedule.schedule,
    ...(schedule.timezone ? { timezone: schedule.timezone } : {}),
    prompt: "",
    action: "board-walk",
  };
}

// ── The cron action ─────────────────────────────────────────────────────────

/** A tick, as a cron run. A skipped tick is not a failure: it would otherwise
 *  read red in the run history every time a slow tick overlaps the next fire. */
export function tickRunResult(tick: TickRecord): CronActionResult {
  const failed = tick.outcome === "failed" || tick.outcome === "invalid-rules";
  return {
    status: failed ? "error" : "success",
    summary: `${tick.outcome}: ${tick.summary}`,
    ...(tick.sessionId ? { sessionId: tick.sessionId } : {}),
    ...(failed ? { error: tick.summary } : {}),
  };
}

export function boardWalkCronHandler(walk: { tick: (trigger: TickRecord["trigger"]) => Promise<TickRecord> }): CronActionHandler {
  return async (_job, trigger) => tickRunResult(await walk.tick(trigger));
}

// ── Seeding and the one-time move out of board-walk.md ──────────────────────

export interface JobSeedResult {
  /** The job was created by this call. */
  created: boolean;
  /** It was built from board-walk.md's old frontmatter, not the defaults. */
  fromFrontmatter: boolean;
  job?: CronJob;
  /** Why the job was created switched off although the old file had it on. */
  notes: string[];
  /** The retired keys taken out of board-walk.md. */
  movedKeys: string[];
  /** Where the file was copied before they were taken out. */
  rulesBackupPath?: string;
  /** Retired keys left in board-walk.md, unread: the rewrite could not be
   *  verified, or the job already existed. */
  ignoredKeys: string[];
  /** The job had been seeded before and is gone: the operator deleted it. */
  deleted: boolean;
  error?: string;
}

export interface JobSeedOptions {
  home: string;
  now: () => Date;
  /** A timezone carried over from a converted `gateway.idleCapacity` block. */
  legacyTimezone?: string;
}

function stamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, "utf-8");
  fs.renameSync(tmp, file);
}

/** The jobs on disk, or a reason not to touch the file. A jobs.json that does
 *  not parse is never rewritten: that would drop every job in it. */
function readJobsFile(file: string): { jobs: CronJob[] } | { error: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { jobs: [] };
    return { error: `could not read ${file}: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? { jobs: parsed as CronJob[] } : { error: `${file} is not a JSON array; the board-walk job was not added` };
  } catch {
    return { error: `${file} is not valid JSON; the board-walk job was not added` };
  }
}

interface OldSchedule {
  enabled: boolean;
  schedule: string;
  timezone?: string;
  fromFrontmatter: boolean;
  notes: string[];
}

type Mapping = Record<string, unknown> | undefined;

function has(mapping: Mapping, key: string): mapping is Record<string, unknown> {
  return mapping !== undefined && Object.prototype.hasOwnProperty.call(mapping, key);
}

/** A string value, trimmed; `bad` when the key holds something else. */
function stringValue(mapping: Mapping, key: string): { value?: string; bad: boolean } {
  if (!has(mapping, key) || mapping[key] === null) return { bad: false };
  const raw = mapping[key];
  if (typeof raw !== "string") return { bad: true };
  return raw.trim() ? { value: raw.trim(), bad: false } : { bad: false };
}

function oldEnabled(mapping: Mapping, notes: string[]): boolean {
  if (!has(mapping, "enabled")) return true;
  if (typeof mapping.enabled === "boolean") return mapping.enabled;
  notes.push("enabled was not true or false, so the job starts switched off");
  return false;
}

function oldCron(mapping: Mapping, notes: string[]): { schedule: string; bad: boolean } {
  const { value, bad } = stringValue(mapping, "schedule");
  const schedule = value ?? BOARD_WALK_DEFAULT_SCHEDULE;
  if (!bad && validateCronSchedule({ schedule }).length === 0) return { schedule, bad: false };
  notes.push(`schedule ${JSON.stringify(mapping?.schedule)} is not a valid cron expression, so the job is hourly and starts switched off`);
  return { schedule: BOARD_WALK_DEFAULT_SCHEDULE, bad: true };
}

function oldZone(mapping: Mapping, legacyTimezone: string | undefined, notes: string[]): { timezone?: string; bad: boolean } {
  const { value, bad } = stringValue(mapping, "timezone");
  const timezone = value ?? (legacyTimezone?.trim() || undefined);
  if (!bad && (timezone === undefined || validateCronSchedule({ schedule: BOARD_WALK_DEFAULT_SCHEDULE, timezone }).length === 0)) {
    return { ...(timezone ? { timezone } : {}), bad: false };
  }
  notes.push(`timezone ${JSON.stringify(mapping?.timezone ?? timezone)} is not a valid IANA zone, so the job has none and starts switched off`);
  return { bad: true };
}

/**
 * The schedule the walk ran on before, from the old frontmatter keys. Anything
 * the old scheduler would not have armed — a schedule or zone that does not
 * validate, an `enabled` that is not true or false — makes the job start
 * switched off, so the move never starts a walk that was not running.
 */
function oldSchedule(mapping: Mapping, legacyTimezone: string | undefined): OldSchedule {
  const notes: string[] = [];
  const enabled = oldEnabled(mapping, notes);
  const cron = oldCron(mapping, notes);
  const zone = oldZone(mapping, legacyTimezone, notes);
  return {
    enabled: enabled && !cron.bad && !zone.bad,
    schedule: cron.schedule,
    ...(zone.timezone ? { timezone: zone.timezone } : {}),
    fromFrontmatter: RETIRED_SCHEDULE_KEYS.some((key) => has(mapping, key)),
    notes,
  };
}

/** The stock comment that sat above each retired key in the shipped file. It
 *  goes with its key; any other comment is the operator's and stays. */
const STOCK_COMMENTS: Record<string, string> = {
  schedule: "# Cron expression. Hourly, on the hour.",
  timezone: "# IANA zone for the schedule and for \"local time\" below. Empty = the gateway host's zone.",
};

const POINTER = `# When the walk runs is the cron job "${BOARD_WALK_JOB_ID}" (Cron, or cron/jobs.json): run it now, change its schedule or switch it off there.`;

/**
 * `text` with the retired keys taken out of its frontmatter, or null when the
 * result cannot be shown to be the same file less those keys. Only the
 * frontmatter changes; the prose below it is left byte for byte.
 */
export function stripRetiredKeys(text: string): { text: string; removed: string[] } | null {
  const span = frontmatterSpan(text);
  const before = frontmatterMapping(text);
  if (!span || !before) return null;
  const cut = cutRetiredLines(text.slice(span.start, span.end).split("\n"));
  if (cut.removed.length === 0) return null;
  const frontmatter = cut.lines.join("\n");
  const expected = { ...before };
  for (const key of RETIRED_SCHEDULE_KEYS) delete expected[key];
  if (!isDeepStrictEqual(loadOrNull(frontmatter), expected)) return null;
  return { text: text.slice(0, span.start) + frontmatter + text.slice(span.end), removed: cut.removed };
}

function loadOrNull(frontmatter: string): unknown {
  try {
    return yaml.load(frontmatter) ?? {};
  } catch {
    return null;
  }
}

function retiredKey(line: string): string | undefined {
  const key = /^([A-Za-z]+)\s*:/.exec(line)?.[1];
  return key && (RETIRED_SCHEDULE_KEYS as readonly string[]).includes(key) ? key : undefined;
}

/** The last line of the value that starts on line `i`: indented lines continue it. */
function lastContinuation(lines: string[], i: number): number {
  let last = i;
  while (last + 1 < lines.length && /^[ \t]+\S/.test(lines[last + 1])) last += 1;
  return last;
}

/** The frontmatter lines less each retired key, the indented lines that
 *  continue its value, and the stock comment above it; the pointer goes where
 *  the first one was. */
function cutRetiredLines(lines: string[]): { lines: string[]; removed: string[] } {
  const keep: string[] = [];
  const removed: string[] = [];
  let pointerAt = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const key = retiredKey(lines[i]);
    if (!key) {
      keep.push(lines[i]);
      continue;
    }
    removed.push(key);
    if (keep.at(-1)?.trim() === STOCK_COMMENTS[key]) keep.pop();
    if (pointerAt === -1) pointerAt = keep.length;
    i = lastContinuation(lines, i);
  }
  if (pointerAt !== -1) keep.splice(pointerAt, 0, POINTER + (lines[0]?.endsWith("\r") ? "\r" : ""));
  return { lines: keep, removed };
}

function moveKeysOutOfRules(rulesFile: string, text: string, now: Date, result: JobSeedResult, keys: string[]): void {
  const stripped = stripRetiredKeys(text);
  if (!stripped) {
    result.ignoredKeys = keys;
    return;
  }
  const backup = `${rulesFile}.pre-cron-${stamp(now)}`;
  fs.copyFileSync(rulesFile, backup);
  writeAtomic(rulesFile, stripped.text);
  result.movedKeys = stripped.removed;
  result.rulesBackupPath = backup;
}

function readRulesText(rulesFile: string): string | undefined {
  try {
    return fs.readFileSync(rulesFile, "utf-8");
  } catch {
    return undefined;
  }
}

/**
 * Make sure the walk has its cron job. Idempotent: once the job exists, or has
 * been seeded and deleted, this only reports.
 */
export function seedBoardWalkJob(opts: JobSeedOptions): JobSeedResult {
  const result: JobSeedResult = { created: false, fromFrontmatter: false, notes: [], movedKeys: [], ignoredKeys: [], deleted: false };
  try {
    seedJob(opts, result);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}

function writeMarker(markerFile: string, now: Date, jobId: string, by: string): void {
  writeAtomic(markerFile, JSON.stringify({ seededAt: now.toISOString(), jobId, by }, null, 2) + "\n");
}

function seedJob(opts: JobSeedOptions, result: JobSeedResult): void {
  const jobsFile = path.join(opts.home, "cron", "jobs.json");
  const markerFile = path.join(opts.home, MARKER_FILE);
  const rulesFile = boardWalkPath(opts.home);
  const read = readJobsFile(jobsFile);
  if ("error" in read) {
    result.error = read.error;
    return;
  }
  const text = readRulesText(rulesFile);
  const mapping = text === undefined ? undefined : frontmatterMapping(text);
  const present = RETIRED_SCHEDULE_KEYS.filter((key) => has(mapping, key));
  if (!needsJob(read.jobs, markerFile, opts.now(), present, result)) return;
  const old = oldSchedule(mapping, opts.legacyTimezone);
  const job = boardWalkJob(old);
  writeAtomic(jobsFile, JSON.stringify([...read.jobs, job], null, 2) + "\n");
  writeMarker(markerFile, opts.now(), job.id, old.fromFrontmatter ? "frontmatter" : "default");
  Object.assign(result, { created: true, fromFrontmatter: old.fromFrontmatter, job, notes: old.notes });
  if (text !== undefined && present.length > 0) moveKeysOutOfRules(rulesFile, text, opts.now(), result, present);
}

/** Whether the job should be created now; when not, `result` says why. */
function needsJob(jobs: CronJob[], markerFile: string, now: Date, present: string[], result: JobSeedResult): boolean {
  const marked = fs.existsSync(markerFile);
  const existing = findBoardWalkJob(jobs);
  if (existing || marked) {
    if (existing && !marked) writeMarker(markerFile, now, existing.id, "found");
    result.deleted = !existing;
    result.ignoredKeys = present;
    return false;
  }
  if (jobs.some((job) => job.id.trim().toLowerCase() === BOARD_WALK_JOB_ID)) {
    result.error = `a cron job with id "${BOARD_WALK_JOB_ID}" already exists and is not the board walk; rename it to let the walk have its job`;
    result.ignoredKeys = present;
    return false;
  }
  return true;
}

function describeJob(job: CronJob): string {
  return `${job.schedule}${job.timezone ? ` (${job.timezone})` : ""}, ${job.enabled ? "enabled" : "switched off"}`;
}

/** The boot-log lines for a job seed; empty when there is nothing to say. */
export function describeJobSeed(result: JobSeedResult): string[] {
  const lines: string[] = [];
  if (result.error) lines.push(`could not add the "${BOARD_WALK_JOB_ID}" cron job: ${result.error}`);
  if (result.created && result.job) {
    const source = result.fromFrontmatter ? `from ${BOARD_WALK_FILE}` : "with the default schedule";
    lines.push(`added the "${BOARD_WALK_JOB_ID}" cron job ${source}: ${describeJob(result.job)}${result.notes.length ? ` (${result.notes.join("; ")})` : ""}`);
  }
  if (result.movedKeys.length > 0) {
    lines.push(`moved ${result.movedKeys.join(", ")} out of ${BOARD_WALK_FILE} (old file: ${result.rulesBackupPath})`);
  }
  if (result.deleted) lines.push(`the "${BOARD_WALK_JOB_ID}" cron job was deleted, so the walk runs only when started by hand`);
  if (result.ignoredKeys.length > 0) {
    lines.push(`${result.ignoredKeys.join(", ")} in ${BOARD_WALK_FILE} ${result.ignoredKeys.length === 1 ? "is" : "are"} no longer read: the "${BOARD_WALK_JOB_ID}" cron job schedules the walk`);
  }
  return lines;
}
