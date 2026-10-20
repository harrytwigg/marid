import type { Database as DatabaseType } from "better-sqlite3";
import { initDb } from "../shared/db.js";
import { logger } from "../shared/logger.js";
import type { Session } from "../shared/types.js";
import { getSession, claimSessionDelivery, listSessionsByWorkItem } from "../sessions/registry.js";
import { deliverClaimedSessionDelivery } from "../sessions/callbacks.js";
import { withReportingParent } from "./employee-session-delegation.js";
import { canMessageSession } from "./employee-sessions.js";
import { isExecutionAttempt } from "./link-role.js";
import { owningEmployeeSession } from "./todo-owner-session.js";
import { addTodoStatusChangeListener } from "./live-events.js";
import { addComment } from "./comment-add.js";
import { getWorkItem, type WorkItem } from "./store.js";
import type { AvailabilityRearmResult } from "./availability-resume.js";
import {
  isChildSettle,
  markChildSettles,
  parentsWithPendingSettles,
  pendingChildSettles,
  reopenChildSettles,
  type ChildSettleRow,
} from "./child-settles.js";
import { childSettlePayload, childSettleReason, settleMoverEmployee } from "./child-settle-message.js";

/**
 * Waking a parent Todo's owner when a child Todo settles, whoever started the
 * child. A session's own turn-end callback reaches its parent session only when
 * the child was a session; a child started by the board walk, the Dispatcher
 * or an operator reports to nobody, so the settle itself is the signal.
 *
 * `transition()` writes one `work_item_child_settles` row with the move
 * (`child-settles.ts`). This module batches those rows per parent, flushes
 * them 10 s after the oldest, and sweeps for the ones a restart or a crash left
 * behind. See specs/006-todo-tree-wake/spec.md, Part A.
 */

/** From a parent's oldest pending row to its flush. Fixed, never reset by a later row. */
export const CHILD_SETTLE_BATCH_MS = 10_000;
export const CHILD_SETTLE_SWEEP_MS = 60_000;

export interface ChildSettleWakeDeps {
  /** Whether `name` is an employee in the org: not the operator, not empty. */
  isEmployee(name: string): boolean;
  /** Restart the parent's work through the Todo Dispatcher. */
  redispatch(parentId: string, reason: string): AvailabilityRearmResult;
  now?: () => number;
}

/** Where the flush tells the child-watch heartbeat its session may have run out of children. */
export type ReleaseChildWatch = (sessionId: string) => void;

let releaseChildWatchIfSettled: ReleaseChildWatch = () => undefined;

/** The seam for the child-watch heartbeat: the flush calls this with the session it
 *  woke, or found already told, so the heartbeat can disarm when nothing is left
 *  open. Unset, it does nothing. */
export function setReleaseChildWatchIfSettled(release: ReleaseChildWatch | null): void {
  releaseChildWatchIfSettled = release ?? (() => undefined);
}

/** `owner`'s newest messageable session linked to execute the parent, else the
 *  session through which the owner holds it from outside (`owningEmployeeSession`).
 *  An idle or interrupted session counts: a message starts a turn on it. */
export function parentOwnerSession(parent: WorkItem, owner: string): Session | undefined {
  const working = listSessionsByWorkItem(parent.id)
    .find((session) => session.employee === owner && isExecutionAttempt(session) && canMessageSession(session));
  return working ?? owningEmployeeSession(parent, owner);
}

/** The session id a move's actor names, when it was a session. */
function actorSession(row: ChildSettleRow): Session | undefined {
  return row.actor.startsWith("session:") ? getSession(row.actor.slice("session:".length)) : undefined;
}

/** The owner made the move and knows. */
function isSelfMove(row: ChildSettleRow, owner: string): boolean {
  return settleMoverEmployee(row) === owner;
}

/** That child's own turn-end callback reaches the target, so a wake would tell it twice. */
function reportsToTarget(row: ChildSettleRow, target: Session): boolean {
  const session = actorSession(row);
  return !!session && withReportingParent(session).parentSessionId === target.id;
}

const ids = (rows: readonly ChildSettleRow[]): number[] => rows.map((row) => row.id);

type FlushAfterCommit =
  | { kind: "wake"; parent: WorkItem; target: Session; deliveryId: string | undefined }
  | { kind: "redispatch"; parent: WorkItem; rows: ChildSettleRow[] }
  | { kind: "comment"; parent: WorkItem; rows: ChildSettleRow[] }
  | { kind: "release"; target: Session }
  | { kind: "none" };

/** The wake for these rows, claimed in the outbox. `accepted` when the same rows
 *  were already claimed and taken, so there is nothing left to deliver. */
function claimWake(parent: WorkItem, target: Session, rows: readonly ChildSettleRow[]): { id: string; accepted: boolean } {
  const { delivery } = claimSessionDelivery({
    targetSessionId: target.id,
    sourceKind: "work-item",
    sourceId: parent.id,
    sourceAttempt: `child-settles:${rows[0]!.id}-${rows[rows.length - 1]!.id}`,
    sourceOutcome: "children-settled",
    sourceVersion: 1,
    deliveryKind: "todo-child-settled",
    payload: childSettlePayload(parent, rows),
  });
  return { id: delivery.id, accepted: delivery.status === "accepted" };
}

/** What the flush does for a parent whose owner has no session to take the wake. */
function withoutOwnerSession(db: DatabaseType, parent: WorkItem, rows: ChildSettleRow[]): FlushAfterCommit {
  if (parent.status === "executing") {
    markChildSettles(db, ids(rows), "redispatched");
    return { kind: "redispatch", parent, rows };
  }
  // A blocked parent waits on a person, and a sweep never restarts it: the
  // comment is what whoever resumes it sees.
  markChildSettles(db, ids(rows), "recorded");
  return { kind: "comment", parent, rows };
}

/** The employee to tell about this parent's children, if there is one. A parent
 *  that is closed, not started, or waiting on the operator has none; its rows
 *  stay as the record. */
function ownerToWake(parent: WorkItem | undefined, isEmployee: (name: string) => boolean): string | undefined {
  if (!parent || (parent.status !== "executing" && parent.status !== "blocked")) return undefined;
  return parent.assignee && isEmployee(parent.assignee) ? parent.assignee : undefined;
}

/** One parent's rows decided and marked, inside one transaction. */
function decideFlush(db: DatabaseType, parentId: string, isEmployee: (name: string) => boolean): FlushAfterCommit {
  const rows = pendingChildSettles(parentId, db);
  if (rows.length === 0) return { kind: "none" };
  const parent = getWorkItem(parentId);
  const owner = ownerToWake(parent, isEmployee);
  if (!parent || !owner) {
    markChildSettles(db, ids(rows), "recorded");
    return { kind: "none" };
  }
  const own = rows.filter((row) => isSelfMove(row, owner));
  markChildSettles(db, ids(own), "deduped");
  const told = rows.filter((row) => !own.includes(row));
  if (told.length === 0) return { kind: "none" };
  const target = parentOwnerSession(parent, owner);
  if (!target) return withoutOwnerSession(db, parent, told);
  const deduped = told.filter((row) => reportsToTarget(row, target));
  markChildSettles(db, ids(deduped), "deduped");
  const remaining = told.filter((row) => !deduped.includes(row));
  if (remaining.length === 0) return { kind: "release", target };
  const claim = claimWake(parent, target, remaining);
  markChildSettles(db, ids(remaining), "woken", { deliveryId: claim.id });
  return { kind: "wake", parent, target, deliveryId: claim.accepted ? undefined : claim.id };
}

function deliverWake(parentId: string, target: Session, deliveryId: string): void {
  deliverClaimedSessionDelivery(deliveryId).catch((error) => {
    logger.warn(`[child-settle-wake] Failed to deliver the wake for ${parentId} to session ${target.id}: ${error instanceof Error ? error.message : String(error)}`);
  });
}

function redispatchParent(parent: WorkItem, rows: ChildSettleRow[], deps: ChildSettleWakeDeps): void {
  try {
    // Refused because a dispatcher is already running still counts: the new
    // session reads the tree.
    deps.redispatch(parent.id, childSettleReason(parent, rows));
  } catch (error) {
    // Put the rows back so the sweep tries again, rather than losing the wake.
    reopenChildSettles(ids(rows));
    logger.warn(`[child-settle-wake] Re-dispatching ${parent.id} failed, will retry: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function commentOnParent(parent: WorkItem, rows: ChildSettleRow[]): void {
  try {
    addComment({
      workItemId: parent.id,
      author: "child-settle-wake",
      authorKind: "system",
      body: `${childSettleReason(parent, rows)}\n\nThis Todo is blocked, so nobody was woken. Whoever resumes it should read the children above first.`,
      idempotencyKey: `child-settles:${parent.id}:${rows[0]!.id}-${rows[rows.length - 1]!.id}`,
    });
  } catch (error) {
    logger.warn(`[child-settle-wake] Could not comment on ${parent.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function releaseWatch(target: Session): void {
  try {
    releaseChildWatchIfSettled(target.id);
  } catch (error) {
    logger.warn(`[child-settle-wake] Releasing the child watch of session ${target.id} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Decide one parent's pending rows in one transaction, then act on the decision after the commit. */
export function flushChildSettles(parentId: string, deps: ChildSettleWakeDeps): void {
  const db = initDb();
  const decision = db.transaction(() => decideFlush(db, parentId, deps.isEmployee)).immediate();
  switch (decision.kind) {
    case "wake":
      if (decision.deliveryId) deliverWake(parentId, decision.target, decision.deliveryId);
      releaseWatch(decision.target);
      break;
    case "release":
      releaseWatch(decision.target);
      break;
    case "redispatch":
      redispatchParent(decision.parent, decision.rows, deps);
      break;
    case "comment":
      commentOnParent(decision.parent, decision.rows);
      break;
    case "none":
      break;
  }
}

interface FlushScheduler {
  /** Flush now, and forget the parent's timer. */
  flush(parentId: string): void;
  /** Flush at the end of the window opened by `oldestAt`, unless a timer is already set for it. */
  schedule(parentId: string, oldestAt: number): void;
  /** Flush what is due and time the rest: what makes a wake survive a restart. */
  sweep(): void;
  clear(): void;
}

function createFlushScheduler(deps: ChildSettleWakeDeps): FlushScheduler {
  const now = deps.now ?? Date.now;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const flush = (parentId: string): void => {
    const timer = timers.get(parentId);
    if (timer) clearTimeout(timer);
    timers.delete(parentId);
    try {
      flushChildSettles(parentId, deps);
    } catch (error) {
      logger.warn(`[child-settle-wake] Flushing ${parentId} failed, the sweep will retry: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // One timer per parent, set from its oldest row and left alone by later ones,
  // so a stream of settles cannot keep pushing the wake back.
  const schedule = (parentId: string, oldestAt: number): void => {
    if (timers.has(parentId)) return;
    const timer = setTimeout(() => flush(parentId), Math.max(0, oldestAt + CHILD_SETTLE_BATCH_MS - now()));
    timer.unref?.();
    timers.set(parentId, timer);
  };

  const sweep = (): void => {
    for (const { parentId, oldestAt } of parentsWithPendingSettles()) {
      if (oldestAt + CHILD_SETTLE_BATCH_MS <= now()) flush(parentId);
      else schedule(parentId, oldestAt);
    }
  };

  const clear = (): void => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  };
  return { flush, schedule, sweep, clear };
}

/**
 * Start waking: a flush {@link CHILD_SETTLE_BATCH_MS} after a parent's oldest
 * pending row, a sweep every {@link CHILD_SETTLE_SWEEP_MS} (and once now) for
 * the rows a restart left behind. Returns the function that stops it.
 */
export function startChildSettleWake(deps: ChildSettleWakeDeps): () => void {
  const now = deps.now ?? Date.now;
  const scheduler = createFlushScheduler(deps);

  const removeListener = addTodoStatusChangeListener((event) => {
    if (!isChildSettle(event.item.parentId, event.fromStatus, event.toStatus)) return;
    const parentId = event.item.parentId!;
    const oldest = parentsWithPendingSettles().find((entry) => entry.parentId === parentId);
    scheduler.schedule(parentId, oldest?.oldestAt ?? now());
  });

  scheduler.sweep();
  const sweeper = setInterval(() => {
    try {
      scheduler.sweep();
    } catch (error) {
      logger.warn(`[child-settle-wake] Sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, CHILD_SETTLE_SWEEP_MS);
  sweeper.unref?.();

  return () => {
    removeListener();
    clearInterval(sweeper);
    scheduler.clear();
  };
}
