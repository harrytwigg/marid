import type { RemoteExecutionConfig } from "../shared/config-types.js";
import type { SessionRemoteTarget } from "../shared/remote-department.js";
import { employeeRemoteTarget } from "../shared/remote-target.js";
import type { Employee, RemoteTarget, Session } from "../shared/types.js";
import { remoteScopeFor } from "./session-cwd.js";

/**
 * Where a rate-limited turn's retry or substitute runs.
 *
 * From the employee record, through `employeeRemoteTarget`, so a scoped session retries
 * in its department's stage directory (FR-061) and the profile travels with it: dropping
 * `remoteClaudeConfigDir` does not mean "no profile" but the instance-wide
 * `remote.claudeConfigDir`, a different profile from the one the session was staged and
 * trust-seeded for, and the folder-trust dialog then hangs an unattended PTY.
 *
 * With no employee record the target the turn ran with is used, as before, except for a
 * session bound to a department that ran on a remote host: its working directory there
 * comes from its employee, so the retry is refused rather than run in whatever the turn
 * last passed. A local one waits and retries in its stage directory, as it always has.
 */
export function rateLimitRemoteTarget(opts: RemoteTarget & {
  session: Pick<Session, "id" | "employee" | "scopeDepartment">;
  employee?: Employee;
  config: { remote?: RemoteExecutionConfig };
}): SessionRemoteTarget {
  if (opts.employee) return employeeRemoteTarget(opts.employee, remoteScopeFor(opts.config.remote, opts.session)) ?? {};
  if (opts.session.scopeDepartment && opts.remoteHost) {
    throw new Error(
      `Refusing to retry session ${opts.session.id}: it is bound to department "${opts.session.scopeDepartment}" `
      + "and its employee is not on the roster, so where it runs cannot be worked out",
    );
  }
  const { remoteHost, remoteUser, remoteCwd, remoteClaudeConfigDir } = opts;
  return { remoteHost, remoteUser, remoteCwd, remoteClaudeConfigDir };
}
