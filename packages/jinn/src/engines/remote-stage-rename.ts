import path from "node:path";
import { logger } from "../shared/logger.js";
import { NAMES } from "../shared/codename.js";
import { LEGACY_REMOTE_DEPARTMENTS_DIR, remoteDepartmentsRoot } from "../shared/remote-department.js";
import type { RemoteExecutionConfig } from "../shared/config-types.js";
import { shq, sshRun, type RemoteFacts } from "./remote-stage.js";

/**
 * Move a host's stage directories from the container an earlier codename named to this build's, with the
 * Claude transcripts filed under each stage directory's path (the project key is the path, so resume and
 * compaction would otherwise start from nothing). It merges: each stage directory the new container does
 * not have yet moves across, and one that exists in both is left alone. A stage directory is also left
 * where it is while any process on the host has its working directory inside it (a live session there would
 * have its conversations filed under a key that no longer matches); the next spawn tries again, whether or
 * not the new container exists by then. Where /proc cannot be read that check is skipped. The old container
 * goes once it is empty.
 *
 * Arguments: the old container, the new container, then each Claude config dir to look in.
 */
export const STAGE_RENAME_SCRIPT = `
set -eu
old=$1
new=$2
shift 2
[ -d "$old" ] && [ ! -L "$old" ] || exit 0
real_old=$(cd -P "$old" && pwd -P)
mkdir -p "$new"
real_new=$(cd -P "$new" && pwd -P)
slug_of() { printf '%s' "$1" | sed 's/[^a-zA-Z0-9]/-/g'; }
# The working directories of every process this user can see, read once.
cwds=$([ -d /proc/self ] && ls -l /proc/[0-9]*/cwd 2>/dev/null | sed 's/.* -> //' || true)
busy_in() {
  [ -n "$cwds" ] || return 1
  printf '%s\\n' "$cwds" | awk -v d="$1" 'index($0, d) == 1 && (length($0) == length(d) || substr($0, length(d) + 1, 1) == "/") { found = 1 } END { exit !found }'
}
moved=0
transcripts=0
busy=0
for stage in "$real_old"/*/; do
  [ -d "$stage" ] || continue
  name=$(basename "$stage")
  [ ! -e "$real_new/$name" ] || continue
  if busy_in "$real_old/$name"; then busy=$((busy + 1)); continue; fi
  mv "$real_old/$name" "$real_new/$name"
  moved=$((moved + 1))
  from=$(slug_of "$real_old/$name")
  to=$(slug_of "$real_new/$name")
  for config in "$@"; do
    if [ -d "$config/projects/$from" ] && [ ! -e "$config/projects/$to" ]; then
      mv "$config/projects/$from" "$config/projects/$to"
      transcripts=$((transcripts + 1))
    fi
  done
done
rmdir "$real_old" 2>/dev/null || true
[ "$busy" -eq 0 ] || printf 'busy=%s\\n' "$busy"
[ "$moved" -eq 0 ] || printf 'renamed=%s transcripts=%s\\n' "$real_new" "$transcripts"
`;

/** Bring a host's stage directories (and their transcripts) onto this build's container name. A no-op while the codename is unchanged. */
export async function renameRemoteStages(destination: string, facts: RemoteFacts, remote: RemoteExecutionConfig, claudeConfigDir: string | undefined): Promise<void> {
  if (!NAMES.renamed) return;
  const configDirs = [...new Set([claudeConfigDir, `${facts.home}/.claude`].filter((dir): dir is string => Boolean(dir)))];
  const args = [path.posix.join(remote.root, LEGACY_REMOTE_DEPARTMENTS_DIR), remoteDepartmentsRoot(remote.root), ...configDirs];
  const res = await sshRun(destination, [["sh", "-c", shq(STAGE_RENAME_SCRIPT), "sh", ...args.map(shq)].join(" ")]);
  if (res.code !== 0) logger.warn(`remote: could not move the stage directories on ${destination} to ${remoteDepartmentsRoot(remote.root)}: ${res.stderr.trim() || `exit ${res.code}`}`);
  else if (res.stdout.trim()) logger.info(`remote: department stage directories on ${destination}: ${res.stdout.trim().replace(/\n/g, "; ")}`);
}

