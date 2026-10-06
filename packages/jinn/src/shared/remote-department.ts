import path from "node:path";
import type { Employee } from "./types.js";
import type { RemoteExecutionConfig } from "./config-types.js";

/**
 * Department-scoped employees on remote hosts (FR-060 to FR-066): where their stage
 * directory sits on the host, and the path checks that keep it, and their work area,
 * clear of the gateway's home and of the per-host stage that holds every session's
 * bearer token.
 *
 * Pure and POSIX, like `remote-target.ts`: the paths judged here live on the remote
 * host. The checks are lexical, after normalising; a symlink on the host that leads
 * elsewhere is not seen, which is the guardrail's stated limit, not a sandbox.
 */

/** Directory under `remote.root` that holds one stage directory per scoped department. */
export const REMOTE_DEPARTMENTS_DIR = ".jinn-departments";

/**
 * What `employeeRemoteTarget` needs to place a scoped session (FR-061): the non-open
 * department an employee, or the session being started for it, is held to, and the
 * configured `remote.root` its stage directory sits under.
 */
export interface RemoteScope {
  departmentOf(employee: Employee): string | null;
  remoteRoot: string | undefined;
}

export type { SessionRemoteTarget } from "./types.js";

function normal(p: string): string {
  return path.posix.normalize(p).replace(/\/+$/, "") || "/";
}

function within(child: string, parent: string): boolean {
  const c = normal(child);
  const p = normal(parent);
  return c === p || c.startsWith(p === "/" ? "/" : `${p}/`);
}

/** Whether two remote paths are the same, or one lies inside the other. */
export function remotePathsOverlap(a: string, b: string): boolean {
  return within(a, b) || within(b, a);
}

/** The directory holding every department's stage directory on a host. */
export function remoteDepartmentsRoot(remoteRoot: string): string {
  return path.posix.join(remoteRoot, REMOTE_DEPARTMENTS_DIR);
}

/** `<remote.root>/.jinn-departments/<slug>`. A slug is one directory name under `org/`, never a path. */
export function remoteDepartmentStageDir(remoteRoot: string, slug: string): string {
  if (!slug || slug.includes("/") || slug.startsWith(".")) throw new Error(`"${slug}" is not a department name`);
  return path.posix.join(remoteDepartmentsRoot(remoteRoot), slug);
}

/**
 * FR-061, checked when the roster loads: a scoped employee's work area (its own
 * `remoteCwd`) must stay clear of the department stage directories, which the sync
 * rewrites, and of the mounted gateway home, which would make the whole company home
 * an FR-065 root. The stage directories must also stay clear of the mount, or the
 * sync would write into the gateway's home. Returns why, or null.
 */
export function scopedRemoteTargetProblem(workArea: string | undefined, remote: RemoteExecutionConfig | undefined): string | null {
  if (!remote?.root || !remote.mount) return null; // validateRemoteTarget reports the missing config
  const departments = remoteDepartmentsRoot(remote.root);
  if (remotePathsOverlap(departments, remote.mount)) {
    return `remote.mount "${remote.mount}" overlaps "${departments}", where department-scoped employees' stage directories are synced`;
  }
  if (!workArea) return null;
  if (remotePathsOverlap(workArea, departments)) {
    return `its remoteCwd "${workArea}" overlaps "${departments}", where department stage directories are synced`;
  }
  if (remotePathsOverlap(workArea, remote.mount)) {
    return `its remoteCwd "${workArea}" overlaps remote.mount "${remote.mount}", the mounted gateway home`;
  }
  return null;
}

/**
 * FR-061, checked at spawn, before anything is written: the per-host stage root holds
 * every remote session's `gateway.json` and bearer token, and is known only from the
 * host's facts. A scoped session's work area and stage directory are its FR-065 file
 * roots, so neither may be, contain or lie inside it. Fails closed: without the stage
 * root the spawn is refused.
 */
export function assertScopedRemoteSpawn(
  paths: { stageDir: string; workArea: string | undefined },
  hostStageRoot: string | undefined,
  remote: RemoteExecutionConfig,
): void {
  if (!hostStageRoot) throw new Error("Refusing to spawn a department-scoped remote session: the host's stage root is not known");
  const problem = scopedRemoteTargetProblem(paths.workArea, remote);
  if (problem) throw new Error(`Refusing to spawn a department-scoped remote session: ${problem}`);
  for (const [label, p] of [["stage directory", paths.stageDir], ["remoteCwd", paths.workArea]] as const) {
    if (p && remotePathsOverlap(p, hostStageRoot)) {
      throw new Error(`Refusing to spawn a department-scoped remote session: its ${label} "${p}" overlaps the host's stage root "${hostStageRoot}", which holds every session's gateway token`);
    }
  }
}
