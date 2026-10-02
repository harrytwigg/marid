import { initDb } from '../shared/db.js';
import { classifyEngineFailureText, hasEngineFailureClass } from '../shared/engine-failure.js';
import { readEngineHealth } from '../shared/engine-health.js';
import { logger } from '../shared/logger.js';
import { isBlockDeclared, listWorkItemEvents } from './event-log.js';
import {
  appendRespawnGuardHold,
  checkRespawnGuard,
  lastSettledRun,
  RESPAWN_RATE_LIMIT_COOLDOWN_MS,
  type RespawnGuardHold,
  type SettledRun,
} from './respawn-guards.js';
import { listWorkItemAttemptRuns } from './runs.js';
import { appendWorkItemEvent, listWorkItems, type WorkItem, type WorkItemStatus } from './store.js';

/**
 * The clock-driven counterpart to the respawn guards (PLA-153).
 *
 * `rate_limit_cooldown` refuses a re-dispatch inside a quota window, and until
 * now nothing came back once the window closed: the run settled `rate_limited`,
 * the Todo stopped, and only a human moving its status would start it again.
 * Todos sat five hours past a reset the failure itself had named.
 *
 * So this is a sweep, not a new classifier — everything needed to decide was
 * already stored. The failure text on the settled run says which classes it
 * carries and, often, the moment the window reopens; engine health remembers the
 * same fact per engine across a restart; and the run's own id is the identity
 * that keeps one failure from being resumed twice.
 */

/** The actor a resume records. A clock decided this, and the trail should say so. */
export const AVAILABILITY_RESUME_ACTOR = 'availability-resume';

/** Classes that describe the PROVIDER rather than the work — the same four
 *  `availabilityReason` names, and the only ones a wait can fix. */
const AVAILABILITY_CLASSES = ['quota', 'rate-limit', 'provider-outage', 'network'] as const;

/** Statuses a parked attempt can leave mid-flight work in. `backlog` is absent
 *  because nothing has attempted it yet; `in_review` is the operator's desk;
 *  the sticky terminals are decisions. */
const CANDIDATE_STATUSES: readonly WorkItemStatus[] = ['executing', 'blocked'];

/**
 * Whether a clock may restart this Todo. A failed or interrupted attempt is
 * exactly what the reconciler turns into `blocked`, so a block it derived is
 * still mid-flight work; a block someone declared waits on a person, and only
 * that person moves it.
 */
export function isClockRestartable(item: Pick<WorkItem, 'id' | 'status'>): boolean {
  if (item.status === 'executing') return true;
  return item.status === 'blocked' && !isBlockDeclared(item.id);
}

/** Past this, a stalled Todo stopped being a clock problem: re-arming a day-old
 *  failure is resurrecting history rather than resuming it. Measured from
 *  `endedAt` when no engine named a reset, and from the named reset once it
 *  has passed — so a weekly cap waits out its real window instead of aging
 *  out at 24h (PLA-216). */
const MAX_RESUMABLE_AGE_MS = 24 * 60 * 60_000;

const DEFAULT_RESUME_INTERVAL_MS = 5 * 60_000;

/** How the reopening instant was arrived at, recorded so a resume that fired at
 *  the wrong moment says which of the three answers it believed. */
export type ResetSource = 'stated' | 'engine-health' | 'cooldown';

/** Where the Todo stands after the restart, as the re-arm port reports it back. */
export interface AvailabilityRearmed {
  status: string;
}

export type AvailabilityRearmResult = AvailabilityRearmed | { unavailable: string };

export interface AvailabilityResumeDeps {
  /**
   * Restart the Todo's work, or say why nothing was started. Injected because
   * starting a session is the gateway's job, and `work-items/` does not import
   * `gateway/`.
   */
  rearm(workItemId: string): AvailabilityRearmResult;
  /** Test seam. */
  now?: () => Date;
}

interface Reset {
  at: number;
  source: ResetSource;
}

/** A failure that has waited long enough, with the reset that decided it. */
interface DueResume {
  run: SettledRun;
  reset: Reset;
}

/**
 * One pass: re-arm every Todo whose last attempt died waiting on a provider that
 * has since reopened. Returns how many were resumed. Exported for tests; the
 * gateway runs it on the interval below.
 */
export function sweepAvailabilityResumes(deps: AvailabilityResumeDeps): number {
  const now = deps.now?.() ?? new Date();
  let resumed = 0;
  for (const item of CANDIDATE_STATUSES.flatMap((status) => listWorkItems({ status }))) {
    if (!isClockRestartable(item)) continue;
    const due = dueForResume(item.id, now);
    if (due === undefined) continue;
    // The sweep has already answered the question `rate_limit_cooldown` asks, and
    // from a more specific source than its generic 30 minutes, so letting it
    // answer again would override a reopening the engine itself named.
    const verdict = checkRespawnGuard(item.id, now, { quotaWindowDecided: true });
    if (verdict.state === 'held') {
      recordHoldOnce(item.id, verdict, due.run.endedAt);
      continue;
    }
    if (resumeOne(item.id, due, deps)) resumed++;
  }
  return resumed;
}

/** Whether this Todo is waiting on a provider that has come back, and on whose
 *  word that was decided. Undefined for every Todo this sweep has no business
 *  touching, which is nearly all of them. */
function dueForResume(workItemId: string, now: Date): DueResume | undefined {
  const attempts = listWorkItemAttemptRuns(workItemId);
  // An attempt is still going: whatever it is doing outranks a clock.
  if (attempts.some((attempt) => attempt.endedAt === null)) return undefined;
  const run = lastSettledRun(attempts);
  if (!run || !isAvailabilityFailure(run)) return undefined;
  if (alreadyResumed(workItemId, run.id)) return undefined;
  const reset = resolveReset(run, now);
  const named = reset.source === "stated" || reset.source === "engine-health";
  const ageFrom = named ? reset.at : Date.parse(run.endedAt);
  if (now.getTime() - ageFrom > MAX_RESUMABLE_AGE_MS) return undefined;
  return reset.at > now.getTime() ? undefined : { run, reset };
}

/** Runs whose restart was declined and already reported, so the warning is not
 *  repeated on every pass; a run leaves once it is resumed. Process-local: a
 *  gateway restart reports it once more. */
const declinedRuns = new Set<string>();

/** Hand the Todo to the port and, if it landed, write the resume down. */
function resumeOne(workItemId: string, due: DueResume, deps: AvailabilityResumeDeps): boolean {
  const engine = engineOf(due.run);
  const landed = deps.rearm(workItemId);
  if ('unavailable' in landed) {
    // The sweep asks again every interval for up to a day; say so once per run.
    if (!declinedRuns.has(due.run.id)) {
      declinedRuns.add(due.run.id);
      logger.warn(`Todo ${workItemId} waited out its ${describe(due.run)} but could not be restarted: ${landed.unavailable}`);
    }
    return false;
  }
  declinedRuns.delete(due.run.id);
  appendWorkItemEvent({
    workItemId,
    kind: 'availability_resumed',
    actor: AVAILABILITY_RESUME_ACTOR,
    detail: {
      runId: due.run.id,
      resetAt: new Date(due.reset.at).toISOString(),
      source: due.reset.source,
      status: landed.status,
      ...(engine === undefined ? {} : { engine }),
    },
    versionEffect: 'audit',
  });
  return true;
}

/**
 * Periodic availability resume. Same primitive as the work-item reconciler —
 * unref'd interval, one guarded sweep per tick, ticks never overlap because the
 * sweep is synchronous. Returns a stop function.
 */
export function startAvailabilityResumeSweep(
  deps: AvailabilityResumeDeps,
  intervalMs: number = DEFAULT_RESUME_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => {
    try {
      const resumed = sweepAvailabilityResumes(deps);
      if (resumed > 0) logger.info(`Resumed ${resumed} Todo(s) whose provider window had reopened`);
    } catch (err) {
      logger.warn(`Availability resume sweep failed: ${err instanceof Error ? err.message : err}`);
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** A wait rather than a fault: the provider refused, and time is the fix.
 *  `rate_limited` is checked first because it is the outcome the run ledger
 *  records for a quota window whose text may say nothing useful. */
function isAvailabilityFailure(run: SettledRun): boolean {
  return run.outcome === 'rate_limited'
    || hasEngineFailureClass(classifyEngineFailureText(run.error), ...AVAILABILITY_CLASSES);
}

/**
 * When the provider said it can serve again, in precedence order: what the
 * engine stated in its own failure text, then what engine health recorded for
 * that engine, then the same grace the cooldown guard already gives a quota
 * window. The last is a floor rather than a fact — it exists so a failure that
 * named no reopening still comes back rather than waiting for a human.
 */
function resolveReset(run: SettledRun, now: Date): Reset {
  const stated = classifyEngineFailureText(run.error).resetsAt;
  if (stated !== undefined) return { at: stated * 1000, source: 'stated' };
  const engine = engineOf(run);
  const health = engine === undefined ? undefined : engineReset(engine, now);
  if (health !== undefined) return { at: health, source: 'engine-health' };
  return { at: Date.parse(run.endedAt) + RESPAWN_RATE_LIMIT_COOLDOWN_MS, source: 'cooldown' };
}

/**
 * The engine's own record of when it can serve again.
 *
 * A record still inside its window names that moment, and it is the answer
 * whether the record is `exhausted` or merely `degraded` — a degraded window is
 * a weaker claim about the engine, not a claim about a different time.
 * `readEngineHealth` expires a spent record to `ok` and drops its `until`, which
 * is the engine saying the window it named has closed. A live record that named
 * no window says nothing, so the caller falls through to the cooldown floor.
 */
function engineReset(engine: string, now: Date): number | undefined {
  const record = readEngineHealth(now)[engine];
  if (record === undefined) return undefined;
  if (record.until !== undefined) return Date.parse(record.until);
  return record.state === 'ok' ? now.getTime() : undefined;
}

/** Which engine served the attempt, read off the session that ran it. The run
 *  ledger does not carry one, and without it engine health cannot be asked. */
function engineOf(run: SettledRun): string | undefined {
  const row = initDb()
    .prepare('SELECT engine FROM sessions WHERE id = ?')
    .get(run.sessionId) as { engine: string | null } | undefined;
  return row?.engine ?? undefined;
}

/** One resume per failure. The settled run's id is the failure's identity, and
 *  the audit trail is where that identity is already written down — so a second
 *  tick over unchanged state finds its own last resume and stops. */
function alreadyResumed(workItemId: string, runId: string): boolean {
  return listWorkItemEvents(workItemId)
    .some((event) => event.kind === 'availability_resumed' && event.detail?.runId === runId);
}

/**
 * Record a hold, but only the first time this failure meets this guard. The
 * sweep returns every few minutes and some guards — `blocker_auth` above all —
 * never clear on their own, so appending on every tick would bury the Todo's
 * trail under the same sentence forever.
 */
function recordHoldOnce(workItemId: string, hold: RespawnGuardHold, since: string): void {
  const said = listWorkItemEvents(workItemId).some((event) =>
    event.kind === 'respawn_guard_held' && event.detail?.guard === hold.guard && event.createdAt > since);
  if (!said) appendRespawnGuardHold(workItemId, hold, AVAILABILITY_RESUME_ACTOR);
}

function describe(run: SettledRun): string {
  return run.outcome === 'rate_limited' ? 'quota window' : 'provider outage';
}
