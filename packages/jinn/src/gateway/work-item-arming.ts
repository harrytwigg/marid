import type { Session } from "../shared/types.js";
import type { WriteOrigin } from "../work-items/origin.js";

/**
 * Who a Todo write is recorded as. Which caller may act AS the operator is the
 * status lane's to decide (`work-item-status-lane.ts`).
 */

export type WorkItemCaller = { origin?: WriteOrigin }
  & ({ kind: 'operator'; session?: undefined; callerId?: undefined } | { kind: 'session'; session: Session; callerId: string });

export function workItemActor(caller: WorkItemCaller): string {
  return caller.kind === 'session' ? `session:${caller.callerId}` : 'operator';
}

/**
 * The employee behind the actor, or undefined when there is none: the operator,
 * or a session that carries no employee. Stamped into the transition's detail
 * as `actorEmployee` so a `todo-status` trigger can tell a Todo the
 * assignee claimed themself from one somebody handed to them — the actor string
 * alone names a session id, which the filter cannot compare to an assignee. Like
 * the arming-delegate stamp, it is read from the session's own identity rather
 * than the request, so it is a fact the gateway asserts.
 */
export function workItemActorEmployee(caller: WorkItemCaller): string | undefined {
  return caller.kind === 'session' ? caller.session.employee ?? undefined : undefined;
}
