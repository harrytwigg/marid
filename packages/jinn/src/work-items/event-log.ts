import { initDb } from '../shared/db.js';
import { parseTodoId } from './id.js';
import type { WorkItemEvent, WorkItemStatus } from './store.js';

/**
 * Reading the Todo audit trail.
 *
 * Appending an event is a write on the work-item table and stays in store.ts
 * beside the mutations that emit it; querying the trail afterwards is a separate
 * job with no writers, so it lives here. store.ts re-exports this surface, which
 * is why no caller had to move with it.
 *
 * Nothing here imports a VALUE from store.ts, and the derived-actor names live
 * here rather than there for that reason: store.ts re-exports this module, so a
 * value import back the other way would read a constant before it exists.
 */

/** Everything the trail can say. The vocabulary lives with the reader because
 *  every consumer of an event reads it from here; store.ts re-exports it beside
 *  the append that writes one. */
export type WorkItemEventKind =
  | 'created'
  | 'child_created'
  | 'comment_added'
  | 'comment_edited'
  | 'comment_deleted'
  | 'relation_added'
  | 'relation_removed'
  | 'label_changed'
  | 'attachment_added'
  | 'attachment_removed'
  | 'metadata_edited'
  | 'status_change'
  | 'note'
  | 'session_linked'
  | 'approval_requested'
  | 'approval_decided'
  | 'verify_result'
  | 'escalated'
  | 'claim_rejected'
  | 'claim_expired'
  | 'respawn_guard_held'
  | 'availability_resumed'
  | 'kept_changed'
  | 'recovery_classified'
  | 'recovery_attempted'
  | 'recovery_exhausted'
  | 'anomaly_observed';

/** Actor recorded on the reconciler's own derived writes. */
export const RECONCILER_ACTOR = 'reconciler';
/** The actor a human's own writes carry. An employee is not a human here: the
 *  point of both readers below is that somebody outside the loop decided this. */
export const HUMAN_ACTOR = 'operator';
/** Actor recorded when a park's `parkedUntil` passes and the sweep puts the Todo
 *  back in the queue. A clock decided the move, on a date somebody
 *  chose when they parked it, so it is neither derived nor an agent's word. */
export const PARK_EXPIRY_ACTOR = 'park-expiry';
/** Actor recorded when a Workflow run reflects its own lifecycle onto its bound
 *  Todo. Derived, not declared: a status a phase set on purpose outranks it. */
export const WORKFLOW_RUN_ACTOR = 'workflow:run';

/** Actors whose transitions the system derived rather than a caller declaring. */
const DERIVED_ACTORS: ReadonlySet<string> = new Set([RECONCILER_ACTOR, WORKFLOW_RUN_ACTOR]);

interface StatusTransitionProvenance {
  fromStatus: WorkItemStatus | null;
  actor: string | null;
  detail: string | null;
}

/** Read the newest transition into a status without loading the full audit trail. */
function latestStatusTransition(workItemId: string, toStatus: WorkItemStatus): StatusTransitionProvenance | undefined {
  const db = initDb();
  const id = parseTodoId(workItemId);
  const row = db
    .prepare(
      `SELECT from_status, actor, detail FROM work_item_events
       WHERE work_item_id = ? AND to_status = ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(id, toStatus) as { from_status: WorkItemStatus | null; actor: string | null; detail: string | null } | undefined;
  return row
    ? {
        fromStatus: row.from_status,
        actor: row.actor,
        detail: row.detail,
      }
    : undefined;
}

/**
 * Whether the current block was declared by a caller rather than derived from
 * attempt transport. Historical events without an explicit marker fall back to
 * actor provenance so existing rows retain their intended meaning.
 */
export function isBlockDeclared(workItemId: string): boolean {
  const row = latestStatusTransition(workItemId, 'blocked');
  if (!row) return false;
  if (row.detail) {
    try {
      const detail = JSON.parse(row.detail) as Record<string, unknown>;
      if (detail.declared === true) return true;
      if (detail.declared === false) return false;
    } catch {
      // Historical malformed detail falls through to actor provenance.
    }
  }
  return row.actor !== null && !DERIVED_ACTORS.has(row.actor);
}

/**
 * Whether the current execution state was explicitly reopened from review.
 * Inspect the newest transition into `executing` first so an older bounce
 * cannot outlive a later start or unblock.
 */
export function isReviewBounceDeclared(workItemId: string): boolean {
  return latestStatusTransition(workItemId, 'executing')?.fromStatus === 'in_review';
}

/** Actors whose status moves raise the reconciler's evidence floor. */
const EVIDENCE_FLOOR_ACTORS: readonly string[] = [HUMAN_ACTOR, PARK_EXPIRY_ACTOR];

/**
 * When this Todo was last put somewhere by a decision the attempt receipts must
 * not overrule, or undefined if it never was. Two kinds count: the operator
 * moving it himself (PLA-98), and an expired park putting it back in the queue
 *. Any event carrying a `to_status` counts — a status change and an
 * escalation are both a decision about where the item belongs.
 *
 * The reconciler reads this as an evidence floor: attempt receipts older than
 * the decision cannot describe what happened after it. Without the park half, a
 * Todo parked mid-work would come back from its park and be pulled straight into
 * `in_review` (or re-blocked) by the attempt it finished before it was parked.
 */
export function latestEvidenceFloorAt(workItemId: string): string | undefined {
  const db = initDb();
  const id = parseTodoId(workItemId);
  const row = db
    .prepare(
      `SELECT created_at FROM work_item_events
       WHERE work_item_id = ? AND actor IN (${EVIDENCE_FLOOR_ACTORS.map(() => '?').join(', ')}) AND to_status IS NOT NULL
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(id, ...EVIDENCE_FLOOR_ACTORS) as { created_at: string } | undefined;
  return row?.created_at;
}

function rowToWorkItemEvent(row: Record<string, unknown>): WorkItemEvent {
  let detail: Record<string, unknown> | null = null;
  if (typeof row.detail === 'string' && row.detail) {
    try {
      detail = JSON.parse(row.detail) as Record<string, unknown>;
    } catch {
      detail = null;
    }
  }
  return {
    id: row.id as string,
    workItemId: row.work_item_id as string,
    kind: row.kind as WorkItemEventKind,
    fromStatus: (row.from_status as WorkItemStatus) ?? null,
    toStatus: (row.to_status as WorkItemStatus) ?? null,
    actor: (row.actor as string) ?? null,
    detail,
    createdAt: row.created_at as string,
  };
}

/** List audit trails for several items with one query, oldest-first within
 * each item. Unknown ids receive an empty entry. */
export function listWorkItemEventsForItems(workItemIds: readonly string[]): Map<string, WorkItemEvent[]> {
  const ids = [...new Set(workItemIds.map((id) => parseTodoId(id)))];
  const eventsById = new Map(ids.map((id) => [id, [] as WorkItemEvent[]]));
  if (ids.length === 0) return eventsById;
  const db = initDb();
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db
    .prepare(`SELECT * FROM work_item_events WHERE work_item_id IN (${placeholders}) ORDER BY created_at, rowid`)
    .all(...ids) as Record<string, unknown>[];
  for (const row of rows) {
    const event = rowToWorkItemEvent(row);
    eventsById.get(event.workItemId)?.push(event);
  }
  return eventsById;
}

/** List an item's audit trail, oldest-first (the story reads top-down). */
export function listWorkItemEvents(workItemId: string): WorkItemEvent[] {
  const id = parseTodoId(workItemId);
  return listWorkItemEventsForItems([id]).get(id) ?? [];
}
