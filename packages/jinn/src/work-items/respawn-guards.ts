import { initDb } from '../shared/db.js';
import { classifyEngineFailureText } from '../shared/engine-failure.js';
import { isRateLimitMessage } from '../shared/rateLimit.js';
import { HUMAN_ACTOR, listWorkItemEvents } from './event-log.js';
import { parseTodoId } from './id.js';
import { listWorkItemAttemptRuns, type TodoRun } from './runs.js';
import { appendWorkItemEvent } from './store.js';

/**
 * Pre-claim respawn guards (ICI-731).
 *
 * An automated re-dispatch — a workflow re-arm, a status-driven trigger, any
 * future auto-pickup — asks these four predicates before it takes the Todo's
 * claim. Each answers the same question from a different fact: would another
 * attempt right now actually help? Jinn has had repeat-worker storms, and every
 * one of them was a re-dispatch a cheap read could have refused.
 *
 * A hold is audited and takes NO claim, so a Todo the guards parked is still
 * free for a human to dispatch by hand. Human-initiated pickup never comes
 * through here at all: the operator pressing Dispatch, and `delegate_task`, are
 * somebody deciding to do this work, which is exactly the input these guards
 * are waiting for.
 */

export type RespawnGuard = 'rate_limit_cooldown' | 'blocker_auth' | 'recent_success' | 'active_pr';

export interface RespawnGuardHold {
  state: 'held';
  guard: RespawnGuard;
  reason: string;
}

export type RespawnGuardVerdict = { state: 'allowed' } | RespawnGuardHold;

export interface RespawnGuardOptions {
  /** The caller has already settled when this quota window reopens, from a more
   *  specific source than the clock below — the failure's own stated time, or
   *  the engine's health record. Asking `rate_limit_cooldown` again would answer
   *  that same question generically and override it, so it is skipped. The other
   *  three guards read different facts and still apply. */
  quotaWindowDecided?: boolean;
}

/** How long a quota window parks automated re-dispatch. The same grace the
 *  engine backoff already gives a rate-limited attempt. */
export const RESPAWN_RATE_LIMIT_COOLDOWN_MS = 30 * 60_000;

/** What "recent" means to `recent_success` and `active_pr`. Longer would park
 *  legitimate retries; shorter would not outlast a storm. */
export const RESPAWN_RECENT_WINDOW_MS = 60 * 60_000;

/** A pull request a previous attempt already opened. */
const PR_URL_RE = /https?:\/\/[^\s)]+\/(?:pull|merge_requests)\/\d+/i;

/** One live comment, as the two comment-reading guards need to read it. */
interface GuardComment {
  authorKind: string;
  body: string;
  createdAt: string;
}

/**
 * This Todo's live comments written after `since`, oldest first.
 *
 * Both callers bound `since` to the last hour, so this reads a window rather
 * than a tail: a fixed tail would drop the very comment that clears a guard as
 * soon as a chatty Todo wrote enough newer ones, which turns a hold into a
 * function of how much a Todo talks rather than of what it said.
 */
function liveCommentsSince(workItemId: string, since: string): GuardComment[] {
  const rows = initDb()
    .prepare(
      `SELECT author_kind, body, created_at FROM work_item_comments
        WHERE work_item_id = ? AND deleted_at IS NULL AND created_at > ?
        ORDER BY created_at, rowid`,
    )
    .all(workItemId, since) as { author_kind: string; body: string; created_at: string }[];
  return rows.map((row) => ({ authorKind: row.author_kind, body: row.body, createdAt: row.created_at }));
}

/** A run that reached an outcome, so its `endedAt` is a fact rather than a maybe. */
export type SettledRun = TodoRun & { endedAt: string };

/**
 * Whether an automated re-dispatch of this Todo should proceed.
 *
 * `rate_limit_cooldown` is evaluated FIRST and that ordering is load-bearing:
 * one error text carries several classes, and quota vocabulary ("usage limit",
 * "exceeded limit") routinely arrives alongside the credential vocabulary that
 * makes it `auth-terminal` too. Losing that race parks the Todo behind a guard
 * only a human can clear — while the quota window clears itself.
 */
export function checkRespawnGuard(
  workItemId: string,
  now: Date = new Date(),
  opts: RespawnGuardOptions = {},
): RespawnGuardVerdict {
  const id = parseTodoId(workItemId);
  const lastSettled = lastSettledRun(listWorkItemAttemptRuns(id));
  return (opts.quotaWindowDecided ? undefined : rateLimitCooldown(lastSettled, now))
    ?? blockerAuth(lastSettled)
    ?? recentSuccess(id, lastSettled, now)
    ?? activePullRequest(id, now)
    ?? { state: 'allowed' };
}

/**
 * Record a hold, so a Todo that was not picked up says why rather than going
 * quiet. Audit-only: a guard is a decision about a dispatch, not a change to
 * the Todo.
 */
export function appendRespawnGuardHold(workItemId: string, hold: RespawnGuardHold, actor: string): void {
  appendWorkItemEvent({
    workItemId,
    kind: 'respawn_guard_held',
    actor,
    detail: { guard: hold.guard, reason: hold.reason },
    versionEffect: 'audit',
  });
}

function held(guard: RespawnGuard, reason: string): RespawnGuardHold {
  return { state: 'held', guard, reason };
}

export function lastSettledRun(runs: TodoRun[]): SettledRun | undefined {
  return runs
    .filter((run): run is SettledRun => run.endedAt !== null)
    .reduce<SettledRun | undefined>((latest, run) => (!latest || run.endedAt > latest.endedAt ? run : latest), undefined);
}

/** A quota window is not a failure and does not need a human — it needs time. */
function rateLimitCooldown(run: SettledRun | undefined, now: Date): RespawnGuardHold | undefined {
  if (!run) return undefined;
  if (run.outcome !== 'rate_limited' && !isRateLimitMessage(run.error)) return undefined;
  const clearsAt = Date.parse(run.endedAt) + RESPAWN_RATE_LIMIT_COOLDOWN_MS;
  if (now.getTime() >= clearsAt) return undefined;
  return held('rate_limit_cooldown',
    `run ${run.id} hit a quota window at ${run.endedAt}; automated re-dispatch waits until ${new Date(clearsAt).toISOString()}`);
}

/** Retrying cannot mint credentials, so an auth-shaped failure waits for a human
 *  rather than for a clock. */
function blockerAuth(run: SettledRun | undefined): RespawnGuardHold | undefined {
  if (!run || !isFailure(run) || run.error === null) return undefined;
  if (!classifyEngineFailureText(run.error).classes.has('auth-terminal')) return undefined;
  return held('blocker_auth', `run ${run.id} failed on credentials, which a retry cannot fix: ${firstLine(run.error)}`);
}

/** Work that just succeeded and that nobody has read yet does not need doing
 *  again; it needs reading. */
function recentSuccess(workItemId: string, run: SettledRun | undefined, now: Date): RespawnGuardHold | undefined {
  if (!run || run.outcome !== 'completed') return undefined;
  if (now.getTime() - Date.parse(run.endedAt) >= RESPAWN_RECENT_WINDOW_MS) return undefined;
  if (humanLookedAfter(workItemId, run.endedAt)) return undefined;
  return held('recent_success', `run ${run.id} completed at ${run.endedAt} and no human has looked at it since`);
}

/** A previous attempt already shipped something a reviewer can see; a second
 *  attempt would ship it twice — unless a human has since read it and asked. */
function activePullRequest(workItemId: string, now: Date): RespawnGuardHold | undefined {
  const since = new Date(now.getTime() - RESPAWN_RECENT_WINDOW_MS).toISOString();
  const branch = `build/${workItemId}`;
  // A Todo id ends in digits, so a plain substring test reads `build/AAA-10` as
  // a branch for `AAA-1` and parks a Todo on another one's work. Only a digit
  // can extend the id, so only a digit disqualifies the match — the slug a real
  // branch appends (`build/AAA-1-the-slice`) still counts.
  const branchRef = new RegExp(`${branch}(?!\\d)`);
  for (const comment of liveCommentsSince(workItemId, since)) {
    const carries = PR_URL_RE.test(comment.body) ? 'a pull request for this Todo'
      : branchRef.test(comment.body) ? `branch ${branch}`
      : null;
    if (carries === null) continue;
    // A human who looked AFTER this comment has already weighed the work it
    // announces and asked for another attempt anyway — the same override
    // `recent_success` gives, for the same reason. Anchoring on the comment
    // rather than on "any human ever" keeps work announced after the look held.
    if (humanLookedAfter(workItemId, comment.createdAt)) continue;
    return held('active_pr', `a comment at ${comment.createdAt} already carries ${carries}`);
  }
  return undefined;
}

/** A human comment or a human status move after `anchor` — the look a hold on
 *  unread work is waiting for. */
function humanLookedAfter(workItemId: string, anchor: string): boolean {
  const commented = liveCommentsSince(workItemId, anchor).some((comment) => comment.authorKind === 'operator');
  if (commented) return true;
  // Any event that MOVED the status counts, not only the `status_change` kind:
  // the operator's own max-rounds decision is recorded as `escalated`, and that
  // is the most deliberate look there is. Reading `toStatus` rather than listing
  // kinds keeps the next status-bearing kind from silently dropping out again.
  return listWorkItemEvents(workItemId).some(
    (event) => event.toStatus !== null && event.actor === HUMAN_ACTOR && event.createdAt > anchor,
  );
}

/** A settled run that reported a problem. `rate_limited` is deliberately not one:
 *  a quota window is the cooldown guard's business, not a failure. */
function isFailure(run: SettledRun): boolean {
  return run.outcome !== 'completed' && run.outcome !== 'rate_limited';
}

/** Error text goes into an audit detail, so it is bounded before it gets there. */
function firstLine(text: string): string {
  const line = text.split('\n', 1)[0].trim();
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}
