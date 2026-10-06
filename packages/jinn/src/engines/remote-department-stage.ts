import crypto from "node:crypto";
import { departmentRecord } from "../gateway/department-registry.js";
import { generateStageFileSet } from "../gateway/department-stage/file-set.js";
import { logger } from "../shared/logger.js";
import { resolveJinnHome } from "../shared/paths.js";
import { REMOTE_STAGE_MARKER } from "../shared/remote-farm.js";
import { assertScopedRemoteSpawn, remoteDepartmentsRoot, remoteDepartmentStageDir } from "../shared/remote-department.js";
import type { RemoteExecutionConfig } from "../shared/config-types.js";
import type { SessionRemoteTarget } from "../shared/types.js";
import type { RemoteEngineName } from "../shared/models.js";
import { JINN_DEPARTMENT_ENV } from "../gateway/department-scope/session-env.js";
import { shq, sshRun, type RemoteFacts } from "./remote-stage.js";
import { buildStageTar } from "./stage-tar.js";

/**
 * A department-scoped session on a remote host (FR-060, FR-062).
 *
 * An unscoped remote session's `$JINN_HOME` is a symlink farm over the mounted gateway
 * home, and the company `CLAUDE.md` is linked into its cwd (FARM_SCRIPT). Both would
 * undo the scope, so a scoped session is staged differently:
 *
 *  - its `$JINN_HOME` holds only what reaches the gateway: `gateway.json`, `tmp/` and the
 *    stage marker (SCOPED_FARM_SCRIPT). FARM_SCRIPT itself is untouched;
 *  - its cwd is the department's stage directory on the host, a copy of the local one
 *    (the same generator), synced file by file before every scoped spawn
 *    (STAGE_SYNC_SCRIPT, the `sh` form of `department-stage/sync.ts`). No hash is cached,
 *    so a wiped or edited copy is restored by the next spawn.
 */

/** How long an incoming directory a dead sync left behind survives, as in the local sync. */
const STALE_INCOMING_MINUTES = 60;

/**
 * The scoped variant of FARM_SCRIPT. It keeps the reaping of dead session stages, the
 * per-session lock (the same block, pinned equal by a test), the stage marker, the real
 * `tmp/` and the `asset=` report `ensureAssets` reads, so a wiped per-host stage still
 * restages itself. It links nothing from the mount and nothing into any cwd, and it
 * removes what a farm rebuild left in this home from before the employee was scoped.
 *
 * Arguments: the per-host stage root, this session's home, the reaper's TTL in days.
 */
export const SCOPED_FARM_SCRIPT = `
set -eu
root=$1
home=$2
ttl=$3
mkdir -p "$root" "$root/sessions" "$home" "$home/tmp"
chmod 700 "$root" "$root/sessions" "$home"
# Reap dead session stages. Every spawn rewrites its own session's gateway.json,
# so a live session's directory is never older than its last turn.
find "$root/sessions" -mindepth 1 -maxdepth 1 -type d -mtime +"$ttl" -exec rm -rf {} + 2>/dev/null || true
lock="$home.farm-lock"
tries=0
until mkdir "$lock" 2>/dev/null; do
  took=$(cat "$lock/taken" 2>/dev/null || true)
  case "$took" in ''|*[!0-9]*) took= ;; esac
  if { [ -n "$took" ] && [ $(( $(date +%s) - took )) -gt 20 ]; } \\
    || [ -n "$(find "$lock" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then
    rm -f "$lock/taken"
    rmdir "$lock" 2>/dev/null || true
    continue
  fi
  tries=$((tries + 1))
  if [ "$tries" -ge 800 ]; then
    echo "remote stage: another rebuild of $home has held $lock for too long" >&2
    exit 1
  fi
  sleep 0.05 2>/dev/null || sleep 1
done
date +%s > "$lock/taken"
trap 'rm -f "$lock/taken"; rmdir "$lock" 2>/dev/null || true' EXIT
trap 'exit 1' HUP INT TERM
# Nothing in a department-scoped session's home leads to the gateway home. A link,
# or a filtered directory of links, left by an unscoped rebuild of this home goes.
find "$home" -maxdepth 1 -type l -exec rm -f {} + 2>/dev/null || true
for dir in sessions workflows; do
  if [ -d "$home/$dir" ] && [ ! -L "$home/$dir" ]; then rm -rf "$home/$dir"; fi
done
# Marks this as a remote session's stage, so Marid code started here refuses to
# start a gateway or open a database (shared/local-db-guard.ts).
printf 'remote session stage: department-scoped, nothing here leads to the gateway home\\n' > "$home/${REMOTE_STAGE_MARKER}"
for a in hook-relay.mjs remote-trust-seed.mjs; do
  if [ -f "$root/$a" ] && [ ! -L "$root/$a" ]; then printf 'asset=%s\\n' "$a"; fi
done
`;

/**
 * Apply a department's file set to its stage directory on a host, by the rules of
 * FR-020a, as `department-stage/sync.ts` does locally. The file set arrives as a tar
 * stream on stdin and is unpacked into an incoming directory beside the stage
 * directory, on the same filesystem, so every rename is atomic. Then, file by file:
 *
 *  - a directory nothing exists at yet is moved in whole; an existing one is kept, never
 *    renamed over. Parents come before children, so a link or file standing where a
 *    directory belongs is removed first and nothing is ever written through a link;
 *  - each file whose content or execute bit differs is renamed over the old one, a link
 *    or directory at its path removed first; an unchanged file is not touched;
 *  - anything not in the set is removed afterwards, a file gone from a kept skill
 *    included; the incoming directory goes, and any a dead sync left over an hour ago.
 *
 * The stage directory is never replaced, so its path and inode stay put: the transcript
 * slug and the trust key derive from it, and a running session keeps its cwd. A sync
 * whose stage root is a link, or whose stage directory resolves anywhere but directly
 * under it, or overlaps one of the forbidden trees (the mounted gateway home, the
 * per-host stage root), is refused before anything is changed.
 *
 * Arguments: the departments root (`<remote.root>/.jinn-departments`), the slug, the
 * incoming directory's name, then the forbidden trees.
 */
export const STAGE_SYNC_SCRIPT = `
set -eu
root=$1
slug=$2
incoming_name=$3
shift 3
fail() { echo "remote department stage: $*" >&2; exit 1; }
case "$slug" in ''|.*|*/*) fail "\\"$slug\\" is not a department name" ;; esac
case "$incoming_name" in ".$slug".incoming-??????) ;; *) fail "\\"$incoming_name\\" is not an incoming directory name" ;; esac
stage="$root/$slug"
incoming="$root/$incoming_name"
lists="$incoming-lists"
real() { if [ -e "$1" ]; then (cd -P "$1" && pwd -P); else printf '%s\\n' "$1"; fi; }
overlaps() { case "$1/" in "$2/"*) return 0 ;; esac; case "$2/" in "$1/"*) return 0 ;; esac; return 1; }
[ ! -L "$root" ] || fail "$root is a symbolic link"
mkdir -p "$root"
real_root=$(real "$root")
for tree in "$@"; do
  ! overlaps "$real_root" "$(real "$tree")" || fail "$root overlaps $tree"
done
# A link or a file where the directory belongs is not the directory: nothing is lost by replacing it.
if [ -L "$stage" ] || { [ -e "$stage" ] && [ ! -d "$stage" ]; }; then rm -rf "$stage"; fi
mkdir -p "$stage"
real_stage=$(real "$stage")
[ "$real_stage" = "$real_root/$slug" ] || fail "$stage resolves to $real_stage, outside $real_root"
for tree in "$@"; do
  ! overlaps "$real_stage" "$(real "$tree")" || fail "$stage overlaps $tree"
done
find "$root" -mindepth 1 -maxdepth 1 -type d -name '.*.incoming-*' -mmin +${STALE_INCOMING_MINUTES} -exec rm -rf {} + 2>/dev/null || true
mkdir "$incoming" "$lists"
trap 'rm -rf "$incoming" "$lists"' EXIT
trap 'exit 1' HUP INT TERM
tar -x -o -f - -C "$incoming"
(cd "$incoming" && find . -mindepth 1 -type d) | LC_ALL=C sort > "$lists/dirs"
(cd "$incoming" && find . -type f) | LC_ALL=C sort > "$lists/files"
written=0
removed=0
while IFS= read -r rel; do
  [ -d "$incoming/$rel" ] || continue
  target="$stage/$rel"
  if [ -d "$target" ] && [ ! -L "$target" ]; then continue; fi
  if [ -e "$target" ] || [ -L "$target" ]; then rm -rf "$target"; removed=$((removed + 1)); fi
  mv "$incoming/$rel" "$target"
  written=$((written + 1))
done < "$lists/dirs"
while IFS= read -r rel; do
  [ -f "$incoming/$rel" ] || continue
  new="$incoming/$rel"
  target="$stage/$rel"
  if [ -L "$target" ]; then
    rm -f "$target"
  elif [ -d "$target" ]; then
    rm -rf "$target"
  elif [ -f "$target" ] && cmp -s "$new" "$target" \\
    && { { [ -x "$new" ] && [ -x "$target" ]; } || { [ ! -x "$new" ] && [ ! -x "$target" ]; }; }; then
    continue
  fi
  mv -f "$new" "$target"
  written=$((written + 1))
done < "$lists/files"
# A name with a line break in it cannot be listed one per line, and is never in the
# set: it goes first, so every line below is one whole path.
find "$stage" -mindepth 1 -name '*
*' -exec rm -rf {} + 2>/dev/null || true
{ sed 's/^/d /' "$lists/dirs"; sed 's/^/f /' "$lists/files"; } | LC_ALL=C sort > "$lists/wanted"
(cd "$stage" && {
  find . -mindepth 1 -type d -exec printf 'd %s\\n' {} +
  find . -mindepth 1 -type f -exec printf 'f %s\\n' {} +
  find . -mindepth 1 ! -type d ! -type f -exec printf 'o %s\\n' {} +
}) | LC_ALL=C sort > "$lists/present"
LC_ALL=C comm -23 "$lists/present" "$lists/wanted" > "$lists/extras"
while IFS= read -r line; do
  rel=\${line#? }
  case "$rel" in ./*) ;; *) continue ;; esac
  case "$rel" in */../*|*/..) continue ;; esac
  if [ -e "$stage/$rel" ] || [ -L "$stage/$rel" ]; then rm -rf "$stage/$rel"; removed=$((removed + 1)); fi
done < "$lists/extras"
printf 'written=%s removed=%s\\n' "$written" "$removed"
`;

// ── Over ssh ────────────────────────────────────────────────────────────────

/** Rebuild a scoped session's `$JINN_HOME` (no farm), and return the per-host assets the script found. */
export async function rebuildScopedHome(destination: string, facts: RemoteFacts, sessionHome: string, ttlDays: number): Promise<Set<string>> {
  const command = ["sh", "-c", shq(SCOPED_FARM_SCRIPT), "sh", ...[facts.stageDir, sessionHome, String(ttlDays)].map(shq)].join(" ");
  const res = await sshRun(destination, [command]);
  if (res.code !== 0) {
    throw new Error(`could not build the department-scoped remote JINN_HOME on ${destination}: ${res.stderr.trim() || `exit ${res.code}`}`);
  }
  const present = new Set<string>();
  for (const line of res.stdout.split("\n")) {
    const value = line.trim();
    if (value.startsWith("asset=")) present.add(value.slice("asset=".length));
  }
  return present;
}

/** The ssh remote command that applies a tar stream on stdin to department `slug`'s stage directory. */
export function buildStageSyncCommand(remote: RemoteExecutionConfig, facts: RemoteFacts, slug: string, incomingName: string): string {
  const args = [remoteDepartmentsRoot(remote.root), slug, incomingName, remote.mount, facts.stageDir];
  return ["sh", "-c", shq(STAGE_SYNC_SCRIPT), "sh", ...args.map(shq)].join(" ");
}

function incomingName(slug: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const suffix = [...crypto.randomBytes(6)].map((byte) => alphabet[byte % alphabet.length]).join("");
  return `.${slug}.incoming-${suffix}`;
}

/**
 * Sync department `slug`'s stage directory on a host to what its definition says now
 * (FR-060). Runs before every scoped spawn there, inside the per-host serialisation and
 * before the trust seed, whose `mkdir -p` would otherwise create an empty stage directory.
 */
export async function syncRemoteDepartmentStage(destination: string, facts: RemoteFacts, remote: RemoteExecutionConfig, slug: string): Promise<void> {
  const { files } = generateStageFileSet({ home: resolveJinnHome(), slug, definition: departmentRecord(slug).definition });
  const res = await sshRun(destination, [buildStageSyncCommand(remote, facts, slug, incomingName(slug))], { stdin: buildStageTar(files) });
  if (res.code !== 0) {
    throw new Error(`could not sync department "${slug}"'s stage directory on ${destination}: ${res.stderr.trim() || `exit ${res.code}`}`);
  }
  logger.info(`remote: department "${slug}" stage directory synced on ${destination} (${res.stdout.trim()})`);
}

// ── What a scoped spawn is staged with ──────────────────────────────────────

/**
 * The department a remote spawn is staged for, or undefined for an unscoped one. Throws,
 * before anything is written, when it cannot be staged in scope: a scoped session runs
 * only on Claude (FR-026), only in its department's stage directory, and only with that
 * directory and its work area clear of the mount, the departments root and the per-host
 * stage root, which is known only from the host's facts (FR-061).
 */
export function scopedRemoteDepartment(
  target: SessionRemoteTarget,
  remote: RemoteExecutionConfig,
  facts: Pick<RemoteFacts, "stageDir"> | undefined,
  engine: RemoteEngineName,
): string | undefined {
  const department = target.remoteDepartment;
  if (!department) return undefined;
  if (engine !== "claude") throw new Error(`Refusing to spawn a department-scoped remote session on ${engine}: the department's stage directory uses Claude's layout`);
  const stageDir = remoteDepartmentStageDir(remote.root, department);
  if (target.remoteCwd !== stageDir) {
    throw new Error(`Refusing to spawn a department-scoped remote session in "${target.remoteCwd ?? ""}": it runs in its department's stage directory, ${stageDir}`);
  }
  assertScopedRemoteSpawn({ stageDir, workArea: target.remoteWorkArea }, facts?.stageDir, remote);
  return department;
}

/** `JINN_DEPARTMENT` for the session's environment file (FR-064); nothing for an unscoped session. */
export function remoteDepartmentEnv(department: string | undefined): Record<string, string> {
  return department ? { [JINN_DEPARTMENT_ENV]: department } : {};
}

/** FR-065: the paths a scoped session's jinn MCP server may read on the host, its work area and its stage directory. */
export function remoteDepartmentFileRoots(target: SessionRemoteTarget): string[] {
  if (!target.remoteDepartment) return [];
  return [target.remoteWorkArea, target.remoteCwd].filter((root): root is string => Boolean(root));
}
