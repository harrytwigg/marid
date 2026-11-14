import { initDb } from "../shared/db.js";
import type { JsonObject, Session } from "../shared/types.js";
import { getSession, getSessionDeliveryByQueueItemId, selfCompactionClaimOfDelivery, updateSession } from "./registry.js";
import { SELF_COMPACTION_FOCUS_PREFIX, type CompactionHandoff } from "./self-compaction.js";
import type { SwitchTargetView } from "./switch-target.js";

/**
 * A session's own request to move to another engine, Claude profile or model
 * (`compact_session` with a target): what the request left behind for the resume turn.
 *
 * The request claims the compaction slot, queues the compaction (when the engine has one) and
 * the resume, and writes this record. The compaction's settle writes its outcome onto it; the
 * resume turn, when it starts, applies the switch (`pending-switch-apply.ts`) and removes it.
 * A stop, an operator's switch or a request that fails after writing it removes it too, so the
 * resume then runs as a plain resume.
 */

export const PENDING_SWITCH_KEY = "pendingSwitch";

export type CompactionFailure =
  | "error" | "usage-limit" | "unconfirmed" | "no-summary" | "summary-too-long" | "no-outcome" | "not-supported";

/** How the compaction turn ended: with the summary the new conversation opens on, or why there is none. */
export type CompactionOutcome = { ok: true; summary: string } | { ok: false; reason: CompactionFailure };

export interface PendingSwitch {
  /** The self-compaction claim time; matched to the resume delivery's `sourceAttempt`. */
  claimedAt: number;
  /** The target when requested. */
  from: SwitchTargetView;
  /** The validated target. */
  to: SwitchTargetView;
  /** `same`: model/effort only, on an engine that compacts natively; `new`: a new conversation. */
  conversation: "same" | "new";
  /** The engine the compaction runs on: the session's current one, which is a stand-in's while an override stands (`from.engine` is the engine it will return to). */
  compactedOn?: string;
  /** Whether a native compaction turn was queued before the resume (false: the engine has none). */
  compactionQueued: boolean;
  /** As compact_session's, already validated. */
  handoff: CompactionHandoff;
  /** Set by the compaction's settle. Absent when the resume starts: the compaction left no outcome (`no-outcome`). */
  compaction?: CompactionOutcome;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The session's pending switch, or undefined when none stands (or the stored value is not one). */
export function readPendingSwitch(session: Pick<Session, "transportMeta"> | undefined): PendingSwitch | undefined {
  const raw = session?.transportMeta?.[PENDING_SWITCH_KEY];
  if (!isObject(raw) || typeof raw.claimedAt !== "number" || !isObject(raw.from) || !isObject(raw.to) || !isObject(raw.handoff)) return undefined;
  if (raw.conversation !== "same" && raw.conversation !== "new") return undefined;
  return raw as unknown as PendingSwitch;
}

/** Read the row's meta, hand it to `change`, and write what it returns (nothing when it returns undefined), in one step. */
function changeMeta(sessionId: string, change: (meta: Record<string, unknown>, session: Session) => Record<string, unknown> | undefined): boolean {
  return initDb().transaction(() => {
    const session = getSession(sessionId);
    if (!session) return false;
    const next = change({ ...(session.transportMeta ?? {}) }, session);
    if (!next) return false;
    updateSession(sessionId, { transportMeta: next as JsonObject });
    return true;
  })();
}

/** Record a pending switch, replacing any earlier one. False when the session is gone. */
export function writePendingSwitch(sessionId: string, pending: PendingSwitch): boolean {
  return changeMeta(sessionId, (meta) => ({ ...meta, [PENDING_SWITCH_KEY]: pending as unknown as JsonObject }));
}

/**
 * Remove the pending switch: any (`claimedAt` omitted: a stop, an operator's switch), or only the
 * one a given request wrote (its own failure). True when one was removed.
 */
export function removePendingSwitch(sessionId: string, claimedAt?: number): boolean {
  return changeMeta(sessionId, (meta, session) => {
    const pending = readPendingSwitch(session);
    if (meta[PENDING_SWITCH_KEY] === undefined || (claimedAt !== undefined && pending?.claimedAt !== claimedAt)) return undefined;
    delete meta[PENDING_SWITCH_KEY];
    return meta;
  });
}

/** A stop gave up on a self-compaction resume for good: the switch it carried goes with it. Any other delivery leaves the pending switch alone. */
export function withdrawPendingSwitchOfDelivery(delivery: { targetSessionId: string; deliveryKind: string; sourceAttempt: string }): boolean {
  const claimedAt = selfCompactionClaimOfDelivery(delivery);
  return claimedAt !== undefined && removePendingSwitch(delivery.targetSessionId, claimedAt);
}

/** A turn that may be a pending switch's compaction: what it was asked and when it began. */
export interface CompactionTurn {
  sessionId: string;
  prompt: string;
  startedAt: number;
}

/** Whether `turn` is the compaction `pending` queued: its own `/compact` focus line, begun after the claim (an operator's `/compact`, or an earlier turn, is not). */
function isCompactionOf(pending: PendingSwitch, turn: CompactionTurn): boolean {
  return turn.prompt.startsWith(`/compact ${SELF_COMPACTION_FOCUS_PREFIX}`) && turn.startedAt >= pending.claimedAt;
}

/**
 * Record how the pending switch's compaction ended. Only when a pending switch exists, has no
 * outcome yet, and `turn` is its compaction: an operator's `/compact` after a stop, or a second
 * settle of the same turn, records nothing. True when this call recorded the outcome.
 */
export function recordCompactionOutcome(turn: CompactionTurn, outcome: CompactionOutcome): boolean {
  return changeMeta(turn.sessionId, (meta, session) => {
    const pending = readPendingSwitch(session);
    if (!pending || pending.compaction || !isCompactionOf(pending, turn)) return undefined;
    return { ...meta, [PENDING_SWITCH_KEY]: { ...pending, compaction: outcome } as unknown as JsonObject };
  });
}

/** Whether a turn is already known to have a pending switch worth recording for (cheap read before reading a summary). */
export function awaitsCompactionOutcome(turn: CompactionTurn): PendingSwitch | undefined {
  const pending = readPendingSwitch(getSession(turn.sessionId));
  return pending && !pending.compaction && isCompactionOf(pending, turn) ? pending : undefined;
}

/**
 * The pending switch a starting resume turn belongs to: its queue item's delivery is a
 * self-compaction resume made under the same claim. A stale resume (an earlier request's, or
 * one whose switch was withdrawn) matches nothing and runs as a plain resume.
 */
export function pendingSwitchOfResume(session: Session, queueItemId: string | undefined): PendingSwitch | undefined {
  const pending = readPendingSwitch(session);
  if (!pending || !queueItemId) return undefined;
  const delivery = getSessionDeliveryByQueueItemId(queueItemId);
  return delivery && selfCompactionClaimOfDelivery(delivery) === pending.claimedAt ? pending : undefined;
}
