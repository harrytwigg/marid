import {
  effectiveVerifyMode,
  getWorkItem,
  isBlockDeclared,
  isReviewBounceDeclared,
  listWorkItems,
  RECONCILER_ACTOR,
  STICKY_STATUSES,
  type VerifyMode,
  type WorkItem,
  type WorkItemSource,
  type WorkItemStatus,
} from './store.js';
import { transitionDerived } from './transitions.js';
import { currentApproval } from './approval-rows.js';
import { expireWorkItemClaims } from './claims.js';
import { collectAttemptEvidence, type SessionStatus, type WorkItemAttemptEvidence } from './attempt-evidence.js';
import { closeOrphanedWorkItemRuns, closeRunsForSettledSessions } from './runs.js';
import { releaseExpiredParks } from './park-expiry.js';
import { logger } from '../shared/logger.js';

export type { WorkItemAttemptEvidence } from './attempt-evidence.js';

/**
 * Work-item status reconciler (GRS-003a, elevated to the Todos vocabulary by
 * GRS-021a design §1.1).
 *
 * A work item's status is DERIVED from the terminal/recovery states of its
 * linked execution attempts (sessions), not from scattered ad-hoc writes. The
 * elevated rules:
 *
 *   - `done`/`cancelled` are STICKY. Closes are decisions — session churn never
 *     silently reopens them.
 *   - ZERO linked sessions → untouched (`backlog` is never clobbered).
 *     Attempts older than the operator's own last status move are not linked
 *     evidence at all — see `attempt-evidence.ts`. With nothing left to speak the
 *     whole pass is a no-op, the TRUST close below included; and once something
 *     does speak, ending a review HE opened still needs the newest surviving
 *     attempt to have settled `succeeded`, not merely to exist.
 *   - Any session in flight (`running`/`waiting`) → `executing`.
 *   - Newest attempt with an explicit `succeeded` receipt → `in_review` only on
 *     the `trust` tier, where the TRUST hook below closes it to `done` in the
 *     same pass: nobody is there to declare a cron fire finished. A reviewed
 *     Todo never gets there from a settle — a producer's run also ends
 *     while it waits on QA or the operator — only by its producer's explicit
 *     move. The settle just clears a transient `blocked` back to `executing`.
 *   - Newest attempt with an explicit `failed`/`interrupted` receipt → `blocked`.
 *
 * All writes go through the guarded `transitions.ts` (event-audited, optimistic,
 * sticky-safe) — the reconciler is a consumer of the state machine, not a second
 * write path.
 */

/** A session is "in flight" (work is actively happening) in these states. */
const IN_FLIGHT: ReadonlySet<SessionStatus> = new Set<SessionStatus>(['running', 'waiting']);

/**
 * Whether the TRUST close may end a review the operator moved into himself.
 *
 * His move raised an evidence floor (`attempt-evidence.ts`), and any surviving
 * attempt clears it — but merely existing is not a finished review. Closing over
 * his decision needs what derivation needs to PUT an item in review: nothing in
 * flight, and the newest surviving attempt settled `succeeded`. Newest-first, so
 * a failure landing after a success withholds the close too; those receipts say
 * "it broke again", not "it is finished".
 *
 * With no floor the reconciler is not authority over itself and the close is
 * unconditional, exactly as before.
 */
function trustCloseIsLicensed(attempts: readonly WorkItemAttemptEvidence[], decisionFloorAt?: string): boolean {
  if (!decisionFloorAt) return true;
  if (attempts.some((attempt) => IN_FLIGHT.has(attempt.status))) return false;
  return attempts[0]?.outcome === 'succeeded';
}

/** Declaration provenance that cannot be derived from attempt receipts alone. */
export interface DeriveWorkItemOptions {
  blockDeclared?: boolean;
  reviewBounceDeclared?: boolean;
  /** Only `trust` lets a clean settle derive `in_review`; absent means reviewed. */
  verifyMode?: VerifyMode;
}

/**
 * Pure derivation: given an item's current status, its provenance, and the
 * terminal receipts of its linked sessions **ordered newest-first** (as
 * `listSessionsByWorkItem` returns them, by `last_activity DESC`), return the
 * status the item SHOULD have. Never yields a sticky terminal — `done` is a
 * policy/human decision layered on top by the TRUST hook.
 */
export function deriveWorkItemStatus(
  current: WorkItemStatus,
  attempts: readonly WorkItemAttemptEvidence[],
  source?: WorkItemSource,
  opts?: DeriveWorkItemOptions,
): WorkItemStatus {
  void source; // the workflow-provenance guard it existed for now runs in reconcileWorkItem; kept for call-site readability
  if (STICKY_STATUSES.has(current)) return current;
  if (attempts.length === 0) return current;
  // Review is a governance phase, not a reflection of session transport state.
  // Parent callbacks and review conversations may run on linked sessions after
  // submission; only an explicit review bounce may reopen execution.
  if (current === 'in_review') return current;
  // Explicit declarations are governance state, not session transport state.
  // They remain authoritative until another declared transition moves the Todo.
  if (current === 'blocked' && opts?.blockDeclared) return current;
  if (current === 'executing' && opts?.reviewBounceDeclared) return current;
  if (attempts.some((attempt) => IN_FLIGHT.has(attempt.status))) return 'executing';
  // Nothing in flight — the most recent attempt (index 0, newest-first) is the
  // authority (an old clean settle must not mask a newer failure, and a newer
  // clean retry must clear an older failure).
  const newest = attempts[0].outcome;
  // A clean settle is not a completion declaration: a backlog
  // Todo stays where somebody put it after that attempt ran.
  if (newest === 'succeeded' && opts?.verifyMode === 'trust') return 'in_review';
  if (newest === 'succeeded') return current === 'blocked' ? 'executing' : current;
  if (newest === 'failed' || newest === 'interrupted') return 'blocked';
  return current;
}

export interface ReconcileResult {
  item: WorkItem;
  changed: boolean;
}

/**
 * Reconcile a single work item from its linked sessions, then apply the TRUST
 * auto-close hook. Returns the (possibly updated) item and whether anything
 * changed, or undefined if the id is unknown. A no-op when the derived status
 * already matches — no write, no `updated_at` churn, no events.
 */
export function reconcileWorkItem(id: string): ReconcileResult | undefined {
  const item = getWorkItem(id);
  if (!item) return undefined;
  // Workflow-created Todos predate native Workflow run authority. They are
  // frozen audit records: automatic session reconciliation must never derive,
  // TRUST-close, or otherwise rewrite them. Explicit guarded Todo actions remain
  // available through the normal operator surfaces.
  if (item.source === 'workflow') return { item, changed: false };
  const { attempts, decisionFloorAt } = collectAttemptEvidence(id);
  // Every attempt predates the operator's own move (or the park expiry that
  // re-queued it), so nothing has happened since that decision about where this
  // Todo belongs and the reconciler has nothing to say — neither a derived
  // status nor the TRUST close, which would otherwise end a review he opened
  // himself on the strength of an older receipt.
  if (decisionFloorAt && attempts.length === 0) return { item, changed: false };
  const verifyMode = effectiveVerifyMode(item);
  let derived = deriveWorkItemStatus(item.status, attempts, item.source, { verifyMode });
  // Provenance is only needed when receipt derivation would overwrite the
  // current state. Since a Todo cannot be blocked and executing simultaneously,
  // this performs at most one indexed event-row lookup per reconcile.
  if (derived !== item.status) {
    if (item.status === 'blocked') {
      derived = deriveWorkItemStatus(item.status, attempts, item.source, {
        verifyMode,
        blockDeclared: isBlockDeclared(id),
      });
    } else if (item.status === 'executing') {
      derived = deriveWorkItemStatus(item.status, attempts, item.source, {
        verifyMode,
        reviewBounceDeclared: isReviewBounceDeclared(id),
      });
    }
  }

  let current = item;
  let changed = false;
  if (derived !== item.status) {
    // transitionDerived returns undefined on a sticky/concurrent race — report
    // the fresh truth as unchanged rather than clobbering a deliberate decision.
    // `transient` names the only block this derivation produces: an attempt that
    // failed or was interrupted. Left unsaid it would count as `needs_input`, and
    // a retry that fails again is the same problem, not a new one.
    const updated = transitionDerived(id, derived, RECONCILER_ACTOR, { declared: false }, 'transient');
    if (updated) {
      current = updated;
      changed = true;
    } else {
      const latest = getWorkItem(id);
      return latest ? { item: latest, changed: false } : undefined;
    }
  }

  // TRUST policy hook (design §1.5): an item landing (or sitting) in `in_review`
  // whose effective verify mode is `trust` auto-closes in the SAME pass —
  // settle → in_review → done reads as one truthful story in the event log.
  //
  // A PENDING approval withholds it: an open routed gate IS the review, so
  // closing over one asserts a decision nobody made. This matters most for a
  // Todo-bound Workflow run, which parks its gates here — a trust-tier item would
  // otherwise reach `done` inside one sweep with the merge still unapproved.
  if (current.status === 'in_review' && effectiveVerifyMode(current) === 'trust'
    && trustCloseIsLicensed(attempts, decisionFloorAt)
    && currentApproval(current.id)?.state !== 'pending') {
    const closed = transitionDerived(id, 'done', 'policy:trust', { policy: 'trust', auto: true });
    if (closed) {
      current = closed;
      changed = true;
    }
  }

  return { item: current, changed };
}

export interface ReconcileSweepResult {
  checked: number;
  changed: number;
}

/** The non-sticky statuses a sweep re-derives. `in_review` is included so a
 *  pre-existing trust-tier item settles on the next pass even if its landing
 *  pass predates this code. */
const SWEEP_STATUSES: readonly WorkItemStatus[] = ['backlog', 'executing', 'in_review', 'blocked'];

/**
 * Reconcile every non-sticky item. Invoked at gateway startup right after
 * `recoverStaleSessions()` (the exact moment `running` sessions became
 * `interrupted`, so their items must move to `blocked`) and periodically by
 * `startWorkItemReconciler` (so trust-tier settles reach `done` while the
 * gateway runs, not just at the next boot). One indexed session query per
 * candidate — negligible at this table's scale (see GRS-003a's note).
 */
export function reconcileActiveWorkItems(): ReconcileSweepResult {
  const candidates = SWEEP_STATUSES.flatMap((status) => listWorkItems({ status }));
  let changed = 0;
  for (const item of candidates) {
    const result = reconcileWorkItem(item.id);
    if (result?.changed) changed++;
  }
  return { checked: candidates.length, changed };
}

/**
 * Startup hook: repair the run ledger, reconcile work items, and log a one-line
 * summary. Best-effort — a reconcile failure must never block gateway boot
 * (mirrors the cron consumer's guard). Returns the count of items whose status
 * changed (0 on any error); a settled run is a ledger repair, not a status
 * change, so those are deliberately not counted.
 */
export function reconcileWorkItemsOnStartup(): number {
  try {
    const orphaned = closeOrphanedWorkItemRuns();
    if (orphaned > 0) {
      logger.info(`Settled ${orphaned} run(s) as crashed: the session running them is gone`);
    }
    closeRunsForSettledSessions();
    const released = expireWorkItemClaims();
    if (released > 0) {
      logger.info(`Released ${released} Todo claim(s) whose lease ran out with nobody reporting against it`);
    }
    // Before the reconcile, so a park that ran out while the gateway was down is
    // back in the queue — and its evidence floor laid — before anything derives.
    const unparked = releaseExpiredParks();
    if (unparked > 0) {
      logger.info(`Re-queued ${unparked} Todo(s) whose park had run out`);
    }
    const { checked, changed } = reconcileActiveWorkItems();
    if (changed > 0) {
      logger.info(`Reconciled ${changed} work item(s) from linked session state (of ${checked} non-sticky)`);
    }
    return changed;
  } catch (err) {
    logger.warn(`Work-item startup reconcile skipped: ${err instanceof Error ? err.message : err}`);
    return 0;
  }
}

const DEFAULT_RECONCILE_INTERVAL_MS = 20_000;

/**
 * Periodic work-item reconcile (GRS-021a): without it, a session that settles
 * mid-process would only reach its derived status at the NEXT boot or the next
 * mint-time reconcile — a stale ledger, the exact failure Todos exist to kill.
 * Same primitive as the gateway's status reconciler (unref'd interval, one
 * guarded sweep per tick, ticks never overlap because the sweep is synchronous).
 * Returns a stop function.
 */
export function startWorkItemReconciler(intervalMs: number = DEFAULT_RECONCILE_INTERVAL_MS): () => void {
  const timer = setInterval(() => {
    try {
      // A park whose date has passed goes back to the queue; nothing
      // else ends one, so without this it sits in `blocked` until a human looks.
      const unparked = releaseExpiredParks();
      if (unparked > 0) logger.info(`Re-queued ${unparked} Todo(s) whose park had run out`);
      reconcileActiveWorkItems();
      // Sticky Todos are outside the sweep above, so their rows are closed here
      // or never — a cancel mid-delegation must not strand an open attempt.
      closeRunsForSettledSessions();
      // A lease outlives the worker that took it, so without this nothing hands
      // the Todo back when the gateway holding it dies mid-work.
      expireWorkItemClaims();
    } catch (err) {
      logger.warn(`Work-item reconcile sweep failed: ${err instanceof Error ? err.message : err}`);
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
