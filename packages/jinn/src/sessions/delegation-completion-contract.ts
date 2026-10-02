/**
 * KNOWN LIMITATION: completion classification is heuristic and fail-safe-biased.
 * It nudges only explicit task-incomplete assertions and surfaces everything
 * else—including finished, ambiguous, and awaiting-parent replies—to the parent.
 * A rare mis-nudge costs at most MAX_STOP_NUDGES redundant continue-messages to
 * a done child and then self-corrects. The real contract is structural:
 * delegation provenance, an atomic once-per-idle claim, and startup recovery
 * for orphaned claims.
 */
import type { Session } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { getWorkItem } from "../work-items/store.js";
import {
  claimDelegationCompletionNudge,
  clearDelegationCompletionGuard,
  getSession,
  markDelegationCompletionSurfaced,
  releaseDelegationCompletionNudge,
} from "./registry.js";
import { isNonTerminalNarration, MAX_STOP_NUDGES, STOP_NUDGE_TEXT } from "./stop-nudge.js";

const META_KEY = "delegationCompletionContract";
export const DELEGATION_COMPLETION_TRACKED_META_KEY = "delegationCompletionTracked";
const OPEN_EXECUTION_STATUSES = new Set(["backlog", "executing"]);

export const DELEGATION_COMPLETION_NUDGE_DISPLAY =
  "Completion contract: continuing this delegated task to a final report.";

type GuardState = "nudged" | "surfaced";

interface Guard {
  workItemId: string;
  state: GuardState;
  nudges: number;
}

export type DelegationCompletionOutcome = "pass" | "nudged" | "surface" | "suppress";

export interface DelegationCompletionDeps {
  postFollowUp: (sessionId: string, message: string, displayMessage: string) => Promise<void>;
}

function readGuard(session: Session): Guard | null {
  const raw = session.transportMeta?.[META_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const guard = raw as Record<string, unknown>;
  if (typeof guard.workItemId !== "string") return null;
  if (guard.state !== "nudged" && guard.state !== "surfaced") return null;
  // A guard persisted before the count existed has already spent one nudge, so
  // an upgrade in flight resumes on its budget rather than restarting it.
  const nudges = typeof guard.nudges === "number" ? guard.nudges : 1;
  return { workItemId: guard.workItemId, state: guard.state, nudges };
}

function isStructurallyAwaitingParent(session: Session): boolean {
  return session.transportMeta?.awaitingParent === true || session.transportMeta?.delegationAwaitingParent === true;
}

/**
 * Gate the ordinary parent-completion callback for a narrowly qualified child.
 *
 * DESIGN BIAS — conservative and fail-safe:
 * The auto-nudge is only an additive optimization over the existing parent
 * callback. Structural provenance is mandatory and text is only a secondary
 * refinement. Any missing evidence, ambiguity, parse collision, or failed CAS
 * returns `pass`, preserving the normal surface-to-parent behavior. Missed
 * nudges are acceptable; false nudges are the harm this contract prevents.
 *
 * The persisted guard is deliberately independent of engine attempt ids: each
 * contract nudge creates a new attempt, and the settlement of that attempt is
 * counted against the same MAX_STOP_NUDGES budget. Once the budget is spent, or
 * once the child stops narrating, the settlement surfaces to the parent.
 */
export async function enforceDelegationCompletionContract(
  session: Session,
  result: { result?: string | null; error?: string | null },
  deps: DelegationCompletionDeps,
): Promise<DelegationCompletionOutcome> {
  if (!session.parentSessionId || session.status !== "idle" || result.error) return "pass";
  if (!session.workItemId) return "pass";
  if (session.transportMeta?.[DELEGATION_COMPLETION_TRACKED_META_KEY] !== true) return "pass";
  if (isStructurallyAwaitingParent(session)) return "pass";

  const item = getWorkItem(session.workItemId);
  if (!item || !OPEN_EXECUTION_STATUSES.has(item.status)) return "pass";

  const guard = readGuard(session);
  const active = guard?.workItemId === session.workItemId ? guard : null;
  if (active?.state === "surfaced") return "pass";

  const text = result.result?.trim() ?? "";
  const narrating = text.length > 0 && isNonTerminalNarration(text);

  if (active && (active.nudges >= MAX_STOP_NUDGES || !narrating)) {
    if (!markDelegationCompletionSurfaced(session.id, session.workItemId)) {
      const persisted = getSession(session.id);
      return persisted && readGuard(persisted)?.workItemId === session.workItemId ? "suppress" : "pass";
    }
    return "surface";
  }

  if (!narrating) return "pass";

  const sentNudges = active?.nudges ?? 0;
  const guarded = claimDelegationCompletionNudge(session.id, session.workItemId, sentNudges);
  if (!guarded) {
    const persisted = getSession(session.id);
    return persisted && readGuard(persisted)?.workItemId === session.workItemId ? "suppress" : "pass";
  }
  try {
    await deps.postFollowUp(session.id, STOP_NUDGE_TEXT, DELEGATION_COMPLETION_NUDGE_DISPLAY);
    return "nudged";
  } catch (error) {
    releaseDelegationCompletionNudge(session.id, session.workItemId, sentNudges);
    logger.warn(
      `[delegation-contract] failed to nudge child ${session.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return "pass";
  }
}

/** A genuine operator/user follow-up starts a fresh completion-contract cycle. */
export function clearDelegationCompletionContract(session: Session): Session {
  const guard = readGuard(session);
  if (!guard) return session;
  return clearDelegationCompletionGuard(session.id, guard.workItemId) ?? getSession(session.id) ?? session;
}
