import path from "node:path";
import { logger } from "../shared/logger.js";
import { NAMES } from "../shared/codename.js";
import { LEGACY_REMOTE_DEPARTMENTS_DIR, remoteDepartmentsRoot } from "../shared/remote-department.js";
import type { RemoteExecutionConfig } from "../shared/config-types.js";
import { shq, sshRun, type RemoteFacts } from "./remote-stage.js";

/**
 * Move a host's stage directories from the container an earlier codename named to this build's, once,
 * with the Claude transcripts filed under each stage directory's path (the project key is the path, so
 * resume and compaction would otherwise start from nothing). Nothing is done unless the old container
 * is a real directory and the new one does not exist.
 *
 * Arguments: the old container, the new container, then each Claude config dir to look in.
 */
export const STAGE_RENAME_SCRIPT = `
set -eu
old=$1
new=$2
shift 2
[ -d "$old" ] && [ ! -L "$old" ] && [ ! -e "$new" ] || exit 0
real_old=$(cd -P "$old" && pwd -P)
mv "$old" "$new"
real_new=$(cd -P "$new" && pwd -P)
slug_of() { printf '%s' "$1" | sed 's/[^a-zA-Z0-9]/-/g'; }
moved=0
for stage in "$real_new"/*/; do
  [ -d "$stage" ] || continue
  name=$(basename "$stage")
  from=$(slug_of "$real_old/$name")
  to=$(slug_of "$real_new/$name")
  for config in "$@"; do
    if [ -d "$config/projects/$from" ] && [ ! -e "$config/projects/$to" ]; then
      mv "$config/projects/$from" "$config/projects/$to"
      moved=$((moved + 1))
    fi
  done
done
printf 'renamed=%s transcripts=%s\\n' "$real_new" "$moved"
`;

/** Bring a host's stage directories (and their transcripts) onto this build's container name. A no-op while the codename is unchanged. */
export async function renameRemoteStages(destination: string, facts: RemoteFacts, remote: RemoteExecutionConfig, claudeConfigDir: string | undefined): Promise<void> {
  if (!NAMES.renamed) return;
  const configDirs = [...new Set([claudeConfigDir, `${facts.home}/.claude`].filter((dir): dir is string => Boolean(dir)))];
  const args = [path.posix.join(remote.root, LEGACY_REMOTE_DEPARTMENTS_DIR), remoteDepartmentsRoot(remote.root), ...configDirs];
  const res = await sshRun(destination, [["sh", "-c", shq(STAGE_RENAME_SCRIPT), "sh", ...args.map(shq)].join(" ")]);
  if (res.code !== 0) logger.warn(`remote: could not move the stage directories on ${destination} to ${remoteDepartmentsRoot(remote.root)}: ${res.stderr.trim() || `exit ${res.code}`}`);
  else if (res.stdout.includes("renamed=")) logger.info(`remote: moved the department stage directories on ${destination} (${res.stdout.trim()})`);
}

