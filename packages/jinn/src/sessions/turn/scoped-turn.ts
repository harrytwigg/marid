import { prepareDepartmentStage } from "../../gateway/department-stage/stage.js";
import type { Session } from "../../shared/types.js";
import { lostBindingReason, scopedDepartmentOf } from "../../work-items/department-scope.js";

/**
 * The department-scope gates on a turn (FR-008, FR-020, FR-026): no turn starts in a
 * session whose department binding is lost, a scoped session runs only on the claude
 * engine, whatever a spawn, delegation or fallback asked for, and it starts only once
 * its stage directory is in place: it never falls back to the Jinn home. For a session on
 * a remote host that is the host's copy, which the remote staging prepares.
 */
export function refuseScopedTurn(session: Session, engineOverride: string | undefined, remote = false): string | undefined {
  const department = session.scopeDepartment ?? scopedDepartmentOf(session.employee);
  if (!department) return undefined;
  const lost = lostBindingReason(session);
  if (lost) return `This department-scoped session cannot start a turn: ${lost}.`;
  const engine = engineOverride ?? session.engine;
  if (engine !== "claude") return `A session scoped to department "${department}" runs only on the claude engine, not "${engine}".`;
  // On a remote host the stage directory is the host's copy, synced and checked by the
  // remote staging; the local one plays no part, so it is neither prepared nor required.
  if (remote) return undefined;
  try {
    prepareDepartmentStage(department);
  } catch (err) {
    return `This department-scoped session cannot start a turn: ${err instanceof Error ? err.message : String(err)}.`;
  }
  return undefined;
}
