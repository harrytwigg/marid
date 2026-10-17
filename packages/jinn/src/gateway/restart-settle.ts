import path from "node:path";
import { settleInstanceEnv } from "../instances/canonical-env.js";
import type { HomeRenameDeps } from "../instances/home-rename.js";
import { envNamesFor } from "../shared/codename-env.js";

/**
 * A restart stops the running gateway and starts another, and that gap is the one moment an older build's
 * home can be moved when the command that asked for the restart found a gateway running there. Settle it
 * between the two. Paths in this process were fixed at load from the old location, so when the home did
 * move the helper has to start over as a new process, which reads the settled one.
 */
export async function settleBeforeRestart(
  env: NodeJS.ProcessEnv,
  loadedHome: string,
  deps: HomeRenameDeps = {},
): Promise<{ respawn: boolean }> {
  const outcome = await settleInstanceEnv(env, deps);
  const respawn = path.resolve(outcome.home) !== path.resolve(loadedHome);
  // What the old location derived is wrong for the new one; the new process works its own out.
  if (respawn) for (const key of envNamesFor(["HOME_IDENTITY", "BINDING_HOME"])) delete env[key];
  return { respawn };
}
