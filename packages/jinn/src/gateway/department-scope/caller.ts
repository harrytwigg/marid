import { getSession } from "../../sessions/registry.js";
import type { Session } from "../../shared/types.js";
import { scopedDepartmentOf } from "../../work-items/department-scope.js";
import type { CallerIdentity } from "../session-comm-guards.js";

/**
 * Who a scoped caller is (FR-010): a capability-verified session whose employee is in a
 * non-open department, or that carries a binding. Its department D is the binding
 * (`sessions.scope_department`), fixed when the session was created (FR-008).
 *
 * Scope is read from the live roster on every request. A session whose binding no
 * longer matches its employee's department (the employee moved, or the department was
 * opened), or a scoped employee's session with no binding at all (one created before
 * the department was scoped), has LOST its binding: it is refused everywhere except
 * its own transcript, and `refuseTurn` starts no new turn in it.
 */
export interface ScopedCaller {
  session: Session;
  /** The department the session is held to. */
  department: string;
  /** Why the binding is lost, or null while it holds. */
  lost: string | null;
}

export function lostBindingReason(session: Pick<Session, "employee" | "scopeDepartment">): string | null {
  const live = scopedDepartmentOf(session.employee);
  const bound = session.scopeDepartment ?? null;
  if (bound === live) return null;
  if (bound === null) return `this session of ${session.employee} was created before department "${live}" was scoped, so it has no binding; start a new session`;
  if (live === null) return `this session is bound to department "${bound}", which ${session.employee} is no longer confined to; start a new session`;
  return `this session is bound to department "${bound}", but ${session.employee} is now in department "${live}"; start a new session`;
}

/** The scoped caller behind a resolved identity, or null for anyone unscoped. */
export function resolveScopedCaller(identity: CallerIdentity): ScopedCaller | null {
  if (identity.kind !== "session") return null;
  const session = getSession(identity.callerId);
  if (!session) return null;
  const department = session.scopeDepartment ?? scopedDepartmentOf(session.employee);
  if (!department) return null;
  return { session, department, lost: lostBindingReason(session) };
}
