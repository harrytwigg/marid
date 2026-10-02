import { randomUUID } from 'node:crypto';
import { initDb } from '../shared/db.js';
import { resolveApprovalRouteTarget, resolveRootApprovalTarget } from '../gateway/approval-authority.js';
import { notifyApprovalDecision } from './approval-decision-listener.js';
import { currentApproval } from './approval-rows.js';
import { ApprovalChoiceError, ApprovalNotPendingError, decideApproval } from './approval-decision-row.js';
import { openDescendantsDeepestFirst } from './cascade.js';
import { appendWorkItemEvent, getWorkItem, type ApprovalTargetKind, type WorkItem } from './store.js';
import { transition } from './transitions.js';

/** `workflow:<workflowId>:<runId>:<nodeId>`: a gate an old Workflow run mirrored onto a Todo. */
const isLegacyWorkflowGateRef = (ref: string | null) => /^workflow:[^:]+:[^:]+:[^:]+$/.test(ref ?? '');

export { currentApproval, listApprovals, type WorkItemApproval } from './approval-rows.js';
export { ApprovalChoiceError, ApprovalNotPendingError } from './approval-decision-row.js';
export {
  setTodoApprovalDecisionListener,
  type TodoApprovalDecisionEvent,
  type TodoApprovalDecisionListener,
} from './approval-decision-listener.js';

/**
 * Todo approvals — the native write paths + the approval decision orchestrator
 * (GRS-021b, design §1.3).
 *
 * Two orthogonal facts about a Todo: its lifecycle POSITION (status) and whether
 * a routed decision is pending on it (the approval fields). This module owns the
 * approval fields; `transitions.ts` still owns status. The anti-bottleneck
 * principle is LAW: a fresh Todo NEVER carries an approval (the store's create
 * path structurally cannot attach one) — approval is attached only here, where a
 * routed decision is genuinely required for a deliberately-gated Todo.
 *
 * REQUESTING is agent-legal (`requestApproval`); DECIDING is authority-gated by
 * the gateway helper (manager/COO by default; operator/aCEO only after explicit
 * escalation). `decideWorkItemApproval` is the consequence engine after that
 * authority check succeeds.
 *
 * Consequence rules are FIXED and deterministic (not per-request config):
 *   - approve + status `in_review`  → `transition(done)`
 *   - reject  + status `in_review`  → bounce `transition(executing)` (rounds++;
 *     the bounce that reaches maxRounds stops in `blocked` instead — the transitions
 *     module enforces that)
 *   - any OTHER status              → the decision is recorded, status UNTOUCHED
 *   - a gate MIRRORED from a Workflow run → the decision is recorded, status
 *     UNTOUCHED whatever it is. The run owns its own lifecycle: its gates are
 *     mid-pipeline decisions ("pick a variant", "merge this"), not a review of
 *     the Todo, and the phases after the gate have not run yet.
 */

/** A CHOICE approval offers variants to pick between instead of a bare yes/no.
 *  Deliberately a short list of labels, not a schema: the label IS the value a
 *  downstream consumer reads back. */
export const MAX_APPROVAL_OPTIONS = 8;
export const MAX_APPROVAL_OPTION_LENGTH = 80;

/** Normalize + validate an offered option set. Returns null for "no options"
 *  so a plain approval and an empty list are the same thing. */
export function normalizeApprovalOptions(options: readonly string[] | null | undefined): string[] | null {
  if (options === null || options === undefined) return null;
  if (!Array.isArray(options)) throw new ApprovalChoiceError('approval options must be an array of labels');
  const trimmed = options.map((option) => (typeof option === 'string' ? option.trim() : ''));
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_APPROVAL_OPTIONS) {
    throw new ApprovalChoiceError(`approval offers at most ${MAX_APPROVAL_OPTIONS} options`);
  }
  if (trimmed.some((option) => option.length === 0)) throw new ApprovalChoiceError('approval options must be non-empty labels');
  if (trimmed.some((option) => option.length > MAX_APPROVAL_OPTION_LENGTH)) {
    throw new ApprovalChoiceError(`approval option labels must be at most ${MAX_APPROVAL_OPTION_LENGTH} characters`);
  }
  if (new Set(trimmed).size !== trimmed.length) throw new ApprovalChoiceError('approval options must be unique');
  return trimmed;
}

export interface RequestApprovalInput {
  /** What is being asked of the routed approver (the gate/description text). */
  request: string;
  /** Optional opaque audit/correlation reference. */
  ref?: string | null;
  /** Offered variants — turns this into a CHOICE approval (see above). */
  options?: readonly string[] | null;
  /** Employee slug expected to decide this approval (manager/COO by default). */
  target?: string | null;
  /** Reserve the gate for the human operator: no employee may decide it, not the
   *  COO and not through escalation. */
  operatorOnly?: boolean;
  /** Who requested it (audit only). */
  actor?: string | null;
}

function sameOptions(left: string[] | null, right: string[] | null): boolean {
  if (left === null || right === null) return left === right;
  return left.length === right.length && left.every((option, index) => option === right[index]);
}

/** Mint a `wap_<12hex>` approval-row id (same shape family as comment ids). */
function newApprovalRowId(): string {
  return `wap_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function classifyApprovalTarget(item: WorkItem, inputTarget: string | null | undefined): { target: string | null; kind: ApprovalTargetKind } {
  if (inputTarget === null) return { target: null, kind: 'none' };

  const target =
    inputTarget === undefined
      ? resolveApprovalRouteTarget({ ...item, approvalTarget: null, approvalTargetKind: null }).target
      : inputTarget;
  if (!target) return { target: null, kind: 'none' };

  const root = resolveRootApprovalTarget();
  return { target, kind: root?.kind === 'virtual' && target === root.name ? 'virtual' : 'employee' };
}

/**
 * Attach a PENDING approval to an item (the native "any actor may REQUEST" path,
 * design §1.3). Writes a PENDING `work_item_approvals` row carrying the request
 * text + optional ref, and appends ONE `approval_requested` event —
 * status is orthogonal and left untouched. Idempotent when the item is already
 * pending on the identical (request, ref): no write, no duplicate event (so a
 * workflow-park re-mirror on every sweep stays event-silent). Throws on an
 * unknown item.
 */
export function requestApproval(id: string, input: RequestApprovalInput): WorkItem {
  const db = initDb();
  const ref = input.ref ?? null;
  const options = normalizeApprovalOptions(input.options);
  const operatorOnly = input.operatorOnly === true;
  const txn = db.transaction((): WorkItem => {
    const item = getWorkItem(id);
    if (!item) throw new Error(`requestApproval: work item ${id} not found`);
    const routed = classifyApprovalTarget(item, input.target);
    const current = currentApproval(item.id);
    if (
      current?.state === 'pending' &&
      current.request === input.request &&
      current.ref === ref &&
      current.target === routed.target &&
      current.targetKind === routed.kind &&
      current.operatorOnly === operatorOnly &&
      sameOptions(current.options, options)
    ) {
      return item; // idempotent re-request (e.g. a workflow re-mirroring its gate)
    }
    const now = new Date().toISOString();
    if (current?.state === 'pending') {
      // Overwrite the one pending gate in place (uq_wap_pending caps pending
      // rows at one per item); a re-route also clears any prior escalation.
      db.prepare(
        `UPDATE work_item_approvals
           SET request = ?, ref = ?, target = ?, target_kind = ?, escalated_at = NULL
         WHERE id = ? AND state = 'pending'`,
      ).run(input.request, ref, routed.target, routed.kind, current.id);
    } else {
      db.prepare(
        `INSERT INTO work_item_approvals (id, work_item_id, state, request, ref, target, target_kind, requested_by, requested_at)
         VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
      ).run(newApprovalRowId(), item.id, input.request, ref, routed.target, routed.kind, input.actor ?? 'system', now);
    }
    const approvalId = currentApproval(item.id)!.id;
    // Re-offering a gate replaces its options wholesale (and clears any pick),
    // and re-states its reservation, so re-routing can never leave a stale one.
    db.prepare('DELETE FROM work_item_approval_choices WHERE approval_id = ?').run(approvalId);
    if (options) {
      db.prepare('INSERT INTO work_item_approval_choices (approval_id, options, choice) VALUES (?, ?, NULL)')
        .run(approvalId, JSON.stringify(options));
    }
    db.prepare('DELETE FROM work_item_approval_operator_only WHERE approval_id = ?').run(approvalId);
    if (operatorOnly) {
      db.prepare('INSERT INTO work_item_approval_operator_only (approval_id) VALUES (?)').run(approvalId);
    }
    db.prepare('UPDATE work_items SET updated_at = ?, version = version + 1 WHERE id = ?').run(now, item.id);
    appendWorkItemEvent({
      workItemId: id,
      kind: 'approval_requested',
      actor: input.actor ?? null,
      detail: { request: input.request, ...(ref ? { ref } : {}), ...(options ? { options } : {}), ...(operatorOnly ? { operatorOnly } : {}), ...(routed.target ? { target: routed.target, targetKind: routed.kind } : { targetKind: routed.kind }) },
    });
    return getWorkItem(id)!;
  });
  return txn();
}

export type ApprovalDecision = 'approve' | 'reject';

export interface ArchiveWorkItemOptions {
  human?: boolean;
  callerSessionId?: string;
  note?: string;
  /** Cancel every open descendant first (depth-first), each with its own audited
   *  transition. Honored only together with `human: true` (operator authority). */
  cascade?: boolean;
}

/**
 * Cancel a Todo while closing any outstanding approval record in the same SQLite
 * transaction. Callers are authority-checked by the gateway before reaching this
 * persistence primitive. With `cascade` (human authority only), open descendants
 * are cancelled first, deepest first, so the roll-up gate stays satisfied.
 */
export function archiveWorkItem(id: string, actor: string, opts: ArchiveWorkItemOptions = {}): WorkItem {
  const db = initDb();
  const txn = db.transaction((): WorkItem => {
    let item = getWorkItem(id);
    if (!item) throw new Error(`archiveWorkItem: work item ${id} not found`);
    if (currentApproval(item.id)?.state === 'pending') {
      item = decideApproval(id, 'reject', actor, opts.note ?? 'Todo archived');
    }
    if (item.status === 'cancelled') return item;
    if (opts.cascade && opts.human) {
      for (const descendant of openDescendantsDeepestFirst(db, item)) {
        transition(descendant.id, 'cancelled', actor, {
          human: true,
          detail: { ...(opts.note ? { note: opts.note } : {}), cascadeFrom: item.id },
        });
      }
    }
    return transition(id, 'cancelled', actor, {
      ...(opts.human ? { human: true } : {}),
      ...(opts.callerSessionId ? { callerSessionId: opts.callerSessionId } : {}),
      detail: { action: 'archive', ...(opts.note ? { note: opts.note } : {}) },
    }).item;
  });
  return txn();
}

/** Persist an explicit escalation to the operator/aCEO path. The routed manager
 * or COO still performs this write through the API/MCP authority helper; this
 * low-level function only records the state once authority is established. */
export function escalateApproval(id: string, actor: string, reason?: string): WorkItem {
  const db = initDb();
  const txn = db.transaction((): WorkItem => {
    const item = getWorkItem(id);
    if (!item) throw new Error(`escalateApproval: work item ${id} not found`);
    const current = currentApproval(item.id);
    if (current?.state !== 'pending') throw new ApprovalNotPendingError(id);
    if (current.escalatedAt) return item;
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE work_item_approvals SET escalated_at = ? WHERE id = ? AND state = 'pending'`,
    ).run(now, current.id);
    db.prepare('UPDATE work_items SET updated_at = ?, version = version + 1 WHERE id = ?').run(now, item.id);
    appendWorkItemEvent({
      workItemId: id,
      kind: 'note',
      actor,
      detail: { approvalEscalated: true, ...(reason !== undefined ? { reason } : {}) },
      versionEffect: 'companion',
    });
    return getWorkItem(id)!;
  });
  return txn();
}

export interface DecideWorkItemApprovalInput {
  id: string;
  decision: ApprovalDecision;
  note?: string;
  /** The picked option. Required when the gate offers options and the decision
   *  is `approve`; refused otherwise. Must be one of the offered labels. */
  choice?: string;
  /** Audit actor for the decision + any consequent transition. Default `operator`. */
  decidedBy?: string;
}

export type DecideWorkItemApprovalResult =
  | {
      ok: false;
      code: 'not-found' | 'no-pending' | 'invalid-choice';
      message: string;
    }
  | { ok: true; item: WorkItem; escalated: boolean };

/**
 * Apply a NATIVE approval decision + its fixed status consequence in ONE SQLite
 * transaction (GRS-021b QA finding 2 — no half-applied approved+in_review). The
 * decision write, the `approval_decided` event, the status transition
 * (done / bounce+rounds / escalate), and the status event either ALL commit or
 * NONE do. Guarded on a pending-approval re-read INSIDE the txn, so a
 * double-decide or a decide-after-resolved is a clean refusal, never a partial
 * apply. `decideApproval` and `transition` each open their own transaction; called
 * here they nest as SAVEPOINTs, so a throw from the status write (or a concurrent
 * state change) rolls back the decision too.
 */
function applyNativeDecisionAtomic(
  id: string,
  decision: ApprovalDecision,
  decidedBy: string,
  note: string | undefined,
  choice: string | undefined,
): { item: WorkItem; escalated: boolean } {
  const db = initDb();
  const txn = db.transaction((): { item: WorkItem; escalated: boolean } => {
    const item = getWorkItem(id);
    if (!item) throw new ApprovalNotPendingError(id);
    const pending = currentApproval(item.id);
    if (pending?.state !== 'pending') throw new ApprovalNotPendingError(id);
    // A legacy Workflow gate was its run's decision point, not a review of this
    // Todo: record the decision, but never let it move the Todo.
    const mirroredFromRun = isLegacyWorkflowGateRef(pending.ref);
    // 1. Record the decision (approval fields + approval_decided event).
    decideApproval(id, decision, decidedBy, note, choice);
    // 2. The fixed consequence, in the SAME transaction — a failure here rolls the
    //    decision back with it (atomicity), never leaving approved + in_review.
    let escalated = false;
    if (item.status === 'in_review' && !mirroredFromRun) {
      if (decision === 'approve') {
        transition(id, 'done', decidedBy, { human: true, ...(note !== undefined ? { detail: { note } } : {}) });
      } else {
        const bounced = transition(id, 'executing', decidedBy, {
          human: true,
          bounce: true,
          detail: { rejected: true, ...(note !== undefined ? { critique: note } : {}) },
        });
        escalated = bounced.escalated;
      }
    }
    return { item: getWorkItem(id)!, escalated };
  });
  return txn();
}

/**
 * Decide a Todo's pending approval and apply the fixed consequences (design §1.3).
 * The route's consequence engine — approval authority is enforced UPSTREAM by
 * the gateway helper; this function assumes the caller was already authorized.
 */
export function decideWorkItemApprovalSync(
  input: DecideWorkItemApprovalInput,
): DecideWorkItemApprovalResult {
  const decidedBy = input.decidedBy ?? 'operator';
  const item = getWorkItem(input.id);
  if (!item) return { ok: false, code: 'not-found', message: `work item ${input.id} not found` };
  if (currentApproval(item.id)?.state !== 'pending') {
    return { ok: false, code: 'no-pending', message: `work item ${input.id} has no pending approval to decide` };
  }

  // NATIVE decision → record it AND apply the fixed consequence rules ATOMICALLY
  // (QA finding 2): one transaction, guarded on `pending`, so a status-write
  // failure or a decide-after-resolve race can never leave a half-applied state.
  try {
    const { item: updated, escalated } = applyNativeDecisionAtomic(input.id, input.decision, decidedBy, input.note, input.choice);
    notifyApprovalDecision(updated, input.decision, decidedBy);
    return { ok: true, item: updated, escalated };
  } catch (err) {
    if (err instanceof ApprovalNotPendingError) return { ok: false, code: 'no-pending', message: err.message };
    if (err instanceof ApprovalChoiceError) return { ok: false, code: 'invalid-choice', message: err.message };
    throw err; // a real write failure — the whole decision rolled back; surface it
  }
}

/**
 * Public async compatibility wrapper. The synchronous seam above exists for
 * callers that must compose the approval decision into a larger SQLite
 * transaction; routes and existing consumers keep the established Promise
 * contract (including rejected write failures).
 */
export async function decideWorkItemApproval(
  input: DecideWorkItemApprovalInput,
): Promise<DecideWorkItemApprovalResult> {
  return decideWorkItemApprovalSync(input);
}
