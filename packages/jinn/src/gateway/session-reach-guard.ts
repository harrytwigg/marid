import type { ServerResponse } from "node:http";
import { UNIDENTIFIED_TOOL_CALL_ERROR } from "../mcp/identity.js";
import type { Session } from "../shared/types.js";
import { getSession } from "../sessions/registry.js";
import { reportingParentSessionId } from "../work-items/employee-session-delegation.js";
import { json } from "./route-helpers.js";
import { isDescendantOf, type CallerIdentity } from "./session-comm-guards.js";

/**
 * Whether the caller may act on another session's turns: the operator always,
 * an agent only on a session it spawned (directly or transitively) or delegated
 * to. A tool call that lost its identity fails closed. Answers the refusal
 * itself and returns false; the stop route and the meter's compact route share
 * it, because both act on a session's turns on its behalf.
 */
/** An agent's reach over a session: one it spawned (directly or transitively) or delegated to. */
export function sessionIsWithinReach(session: Session, callerId: string): boolean {
  return isDescendantOf(session.id, callerId, getSession) || reportingParentSessionId(session) === callerId;
}

export function callerMayActOnSession(
  res: ServerResponse,
  session: Session,
  caller: CallerIdentity,
  refusal: { verb: string; instead: string },
): boolean {
  if (caller.kind === "unidentified-tool") {
    json(res, { error: UNIDENTIFIED_TOOL_CALL_ERROR }, 403);
    return false;
  }
  if (caller.kind === "session" && !sessionIsWithinReach(session, caller.callerId)) {
    json(res, {
      error: `session ${session.id} is not a descendant of your session — agents may only ${refusal.verb} sessions they spawned (directly or transitively) or delegated to. ${refusal.instead}`,
    }, 403);
    return false;
  }
  return true;
}
