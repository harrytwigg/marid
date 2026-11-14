// `freshSession` on a delegation: the delegate's next stretch of work on a Todo
// runs in a new session, with a clean context, instead of landing in the session
// it already has there (one session per employee per Todo is otherwise the rule).
//
// The new session goes through the ordinary delegation transaction: spawned,
// linked as the Todo's execution attempt and only then dispatched. This module
// ends the old one at the right moment. The route calls `replaceLiveSession`
// after every refusal has been answered and right before it creates the new
// session, with no await in between, so no reconcile pass ever sees the Todo
// with the old session stopped and the new one not yet linked. The stopped
// session's last activity is the stop itself, so the newer attempt is the one
// the status is derived from from then on.
import { randomUUID } from "node:crypto";
import { logger } from "../shared/logger.js";
import type { Session } from "../shared/types.js";
import { claimWorkItem, getWorkItemClaim, releaseWorkItemClaimForSession } from "../work-items/claims.js";
import { reportingParentSessionId, reportsUpTo } from "../work-items/employee-session-delegation.js";
import { employeeSessionsTable } from "../work-items/employee-sessions.js";
import { getSession, listChildSessions } from "../sessions/registry.js";
import { sessionIsWithinReach } from "./session-reach-guard.js";
import { stopSession } from "./session-stop.js";
import { acquiredTodoClaim, type RouteTodoClaim } from "./todo-claim.js";
import type { ApiContext } from "./api.js";

/** `freshSession` off the wire: absent is false, anything but a boolean is refused. */
export function parseFreshSession(value: unknown): { ok: true; fresh: boolean } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, fresh: false };
  if (typeof value !== "boolean") return { ok: false, error: "freshSession must be a boolean when provided" };
  return { ok: true, fresh: value };
}

/** The transport-meta key on the new session naming the one it replaced, so a replay can say so too. */
export const REPLACED_SESSION_META_KEY = "freshSessionReplaced";

export interface FreshSessionCaller {
  /** Who the new session reports to: the calling session, or one the operator named. */
  delegatorSessionId: string | undefined;
  /** The calling session when an agent is asking; undefined for the operator. */
  sessionCallerId: string | undefined;
}

/**
 * Why a fresh delegation may not end `live`, judged before anything is touched:
 * - it is the session making the call, or one that session reports to, so
 *   stopping it would cut the delegator's own turn, or its manager's, short;
 * - an agent asking may stop only what `POST /api/sessions/:id/stop` lets it
 *   stop, a session it spawned or delegated to: being allowed to delegate the
 *   Todo is not leave to end somebody else's run of it;
 * - sessions are still working for `live`, and their reports would reach a
 *   stopped session and be dropped.
 */
export function freshSessionRefusal(workItemId: string, live: Session, caller: FreshSessionCaller): { status: 403 | 409; error: string } | undefined {
  const { delegatorSessionId, sessionCallerId } = caller;
  if (delegatorSessionId && reportsUpTo(delegatorSessionId, live.id)) {
    return { status: 409, error: delegatorSessionId === live.id
      ? `freshSession would end session ${live.id}, which is the session making this call: it is ${live.employee}'s session `
        + `on Todo ${workItemId}. Finish the turn here, or ask whoever delegated the Todo to start the next phase fresh.`
      : `freshSession would end ${live.employee}'s session on Todo ${workItemId} (${live.id}), which your session reports to. `
        + `Ask that session, or the operator, instead.` };
  }
  if (sessionCallerId && !sessionIsWithinReach(live, sessionCallerId)) {
    return { status: 403, error: `freshSession would end ${live.employee}'s session on Todo ${workItemId} (${live.id}), which is not `
      + `a descendant of your session — agents may only stop sessions they spawned (directly or transitively) or delegated to. `
      + `Delegate without freshSession, or ask the operator or the session's parent.` };
  }
  const working = inFlightReportsTo(live.id);
  if (working.length === 0) return undefined;
  return { status: 409, error: `freshSession would end ${live.employee}'s session on Todo ${workItemId} (${live.id}) while `
    + `${working.length} session(s) still work for it (${working.join(", ")}); their reports would reach a stopped session and be lost. `
    + `Start the next phase fresh once they have reported.` };
}

const IN_FLIGHT = new Set<Session["status"]>(["running", "waiting"]);

/** Sessions in flight whose report goes to `sessionId`: ones it spawned, and ones
 *  a delegation of its own landed in. */
function inFlightReportsTo(sessionId: string): string[] {
  const delegated = employeeSessionsTable()
    .prepare("SELECT session_id FROM work_item_employee_sessions WHERE delegator_session_id = ?")
    .pluck().all(sessionId) as string[];
  const candidates = new Map(listChildSessions(sessionId).map((session) => [session.id, session]));
  for (const id of delegated) {
    const session = candidates.has(id) ? undefined : getSession(id);
    if (session) candidates.set(id, session);
  }
  return [...candidates.values()]
    .filter((session) => IN_FLIGHT.has(session.status) && reportingParentSessionId(session) === sessionId)
    .map((session) => session.id);
}

/**
 * The claim a fresh delegation works under until the old session is ended.
 * When `live` holds the Todo's claim (running, or idle with background work
 * still going) it keeps it until `replaceLiveSession` takes it over, so a
 * refusal answered before then leaves that session untouched. Undefined when
 * it holds none: the delegation claims the Todo the ordinary way.
 */
export function claimBeforeReplacing(workItemId: string, live: Session): RouteTodoClaim | undefined {
  if (getWorkItemClaim(workItemId)?.sessionId !== live.id) return undefined;
  return { owner: heldByOwner(live), bind: () => undefined, release: () => undefined };
}

const heldByOwner = (live: Session): string => `session:${live.id}`;

/**
 * End `live` so the new session can take its place, and hand back the claim
 * the new session binds. A claim still held by `live` (a no-op claim from
 * {@link claimBeforeReplacing}) is released with the session and taken afresh;
 * a claim this delegation already took is returned as it is.
 */
export function replaceLiveSession(
  context: ApiContext,
  input: { workItemId: string; live: Session; effectiveStatus: Session["status"]; claim: RouteTodoClaim },
): RouteTodoClaim {
  const { workItemId, live, claim } = input;
  const stopped = stopSession(context, live, input.effectiveStatus);
  releaseWorkItemClaimForSession(live.id);
  logger.info(`Delegation ${workItemId}: ended ${live.employee}'s session ${live.id} for a fresh one`
    + `${stopped.wasRunning ? " (its turn was cut short)" : ""}`);
  if (claim.owner !== heldByOwner(live)) return claim;
  const owner = `delegation:${randomUUID()}`;
  const taken = claimWorkItem({ workItemId, owner });
  if (taken.state === "acquired") return acquiredTodoClaim(workItemId, owner);
  // Nothing can take the claim between the release and this line: the route
  // runs both in one synchronous step. Should it happen, the new session works
  // unclaimed until its next claim, which is still better than refusing after
  // the old session was ended.
  logger.warn(`Delegation ${workItemId}: the claim freed by ${live.id} could not be retaken (${taken.state})`);
  return claim;
}
