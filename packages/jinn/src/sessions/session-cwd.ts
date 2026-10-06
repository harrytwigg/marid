import { prepareDepartmentStage, resolvedStageDir } from "../gateway/department-stage/stage.js";
import { JINN_HOME } from "../shared/paths.js";
import type { RemoteExecutionConfig } from "../shared/config-types.js";
import type { RemoteScope } from "../shared/remote-department.js";
import { scopedDepartmentOf } from "../work-items/department-scope.js";

/**
 * The working directory of a local session (FR-020b): the Jinn home for everyone, the
 * department's stage directory for a session bound to a scoped department. Every place
 * that spawns a local session, or looks for its transcript, asks here, so a scoped
 * session never starts, retries or attaches in the Jinn home.
 */

interface SessionView {
  employee?: string | null;
  scopeDepartment?: string | null;
}

/** The department a session's cwd belongs to: its binding, else its employee's scoped department. */
export function sessionScopeDepartment(session: SessionView | undefined): string | null {
  return session?.scopeDepartment ?? scopedDepartmentOf(session?.employee) ?? null;
}

/**
 * The cwd to spawn `session` in. For a scoped session this syncs the stage directory
 * first, so an edit a running session made to it is reverted by the next spawn, and it
 * throws rather than fall back to the Jinn home when the directory cannot be prepared.
 * A session on a remote host runs in the host's copy, which the remote staging syncs:
 * the local directory is named, never prepared, so it cannot block that session.
 */
export function spawnCwd(session: SessionView | undefined, remote = false): string {
  const department = sessionScopeDepartment(session);
  if (!department) return JINN_HOME;
  return remote ? resolvedStageDir(department) : prepareDepartmentStage(department);
}

/** Where a session's transcript lives, without touching the stage directory: the slug is derived from this. */
export function transcriptCwd(session: SessionView | undefined): string {
  const department = sessionScopeDepartment(session);
  return department ? resolvedStageDir(department) : JINN_HOME;
}

/**
 * The scope `employeeRemoteTarget` places a remote session by (FR-061), the remote twin
 * of {@link spawnCwd}: the session's binding when there is one, else its employee's
 * scoped department, with stage directories under `remote.root`. Without a session it
 * reads the employee alone.
 */
export function remoteScopeFor(remote: RemoteExecutionConfig | undefined, session?: SessionView): RemoteScope {
  return {
    remoteRoot: remote?.root,
    departmentOf: (employee) => (session ? sessionScopeDepartment({ ...session, employee: session.employee ?? employee.name }) : scopedDepartmentOf(employee.name)),
  };
}
