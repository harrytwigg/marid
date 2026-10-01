import { isPortalAgentSession } from "../sessions/registry.js";
import type { Session } from "../shared/types.js";
import type { WriteOrigin } from "../work-items/origin.js";

/**
 * Who may reach a `todo-status` Workflow trigger filtered on the operator.
 *
 * Two roads lead there and they are deliberately different widths, so they are
 * read side by side rather than a page apart in the route file.
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

/**
 * `asOperator` stamps the transition's recorded actor as `operator`, so a
 * `todo-status` Workflow trigger filtered on the operator fires for work the
 * COO arms on the operator's behalf.
 *
 * That actor string is an authority boundary — filtering on it is what keeps an
 * arbitrary employee from starting a pipeline nobody asked for — so exactly two
 * callers may claim it: the authenticated operator surface, for which it is a
 * no-op, and the gateway's own top-level agent session, the COO the operator is
 * talking to.
 *
 * The COO is deliberately NOT an org employee — the portal is the root, and
 * `resolveRootApprovalTarget()` answers with a VIRTUAL root that matches no
 * session's employee. So the claim cannot be keyed on an employee name; it is
 * keyed on the session shape only the operator's own surfaces produce
 * (`isPortalAgentSession`). An employee session never has that shape, and
 * neither does anything an employee can spawn.
 *
 * The claim never erases the claimant: the audit event's `actor` reads
 * `operator` for the trigger, and its `detail.asOperator` names the session that
 * actually made the call.
 *
 * A granted claim carries the operator's AUTHORITY too, not only their name:
 * the status route passes `human` into `transition()` for it, which is what
 * lets the COO release a sticky terminal on the operator's instruction.
 */
export function authorizeActingAsOperator(caller: WorkItemCaller): { ok: true; actingAs?: string } | { ok: false; error: string } {
  if (caller.kind === 'operator') return { ok: true };
  if (!isPortalAgentSession(caller.session)) {
    const who = caller.session.employee ? `employee "${caller.session.employee}"` : `session ${caller.callerId}`;
    return {
      ok: false,
      error: `asOperator records the transition as the operator and is reserved for the operator surface and the top-level COO session; ${who} must transition as itself`,
    };
  }
  return { ok: true, actingAs: workItemActor(caller) };
}
