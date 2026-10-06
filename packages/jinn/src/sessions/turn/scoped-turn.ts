import type { Session } from "../../shared/types.js";
import { lostBindingReason, scopedDepartmentOf } from "../../work-items/department-scope.js";

/**
 * The department-scope gates on a turn (FR-008, FR-026): no turn starts in a session
 * whose department binding is lost, and a scoped session runs only on the claude
 * engine, whatever a spawn, delegation or fallback asked for.
 */
export function refuseScopedTurn(session: Session, engineOverride: string | undefined): string | undefined {
  const department = session.scopeDepartment ?? scopedDepartmentOf(session.employee);
  if (!department) return undefined;
  const lost = lostBindingReason(session);
  if (lost) return `This department-scoped session cannot start a turn: ${lost}.`;
  const engine = engineOverride ?? session.engine;
  if (engine !== "claude") return `A session scoped to department "${department}" runs only on the claude engine, not "${engine}".`;
  return undefined;
}
