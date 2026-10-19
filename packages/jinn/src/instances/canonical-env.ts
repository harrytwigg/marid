import path from "node:path";
import { NAMES, currentInstanceName, type Names } from "../shared/codename.js";
import { readEnv, setEnv } from "../shared/codename-env.js";
import { resolveJinnHome } from "../shared/home.js";
import { renameHomeIfNeeded, type HomeRenameDeps, type HomeRenameOutcome } from "./home-rename.js";

/**
 * Settle, once and early, which home and which instance name a process is. An older install names its
 * home by path (`JINN_HOME=~/.jinn-x`) and its instance by `JINN_INSTANCE=jinn-x`; this build names them
 * `~/.<codename>-x` and `<codename>-x`. The home is moved if it needs to be (home-rename.ts), the
 * environment is then rewritten to the canonical path and name under every spelling, and nothing after
 * this sees a second identity for the same directory: the stage root, the registry entry, the cookie
 * names and the transcripts' project keys all derive from what is set here.
 *
 * Runs before any module that evaluates its paths at load time is imported.
 */
export async function settleInstanceEnv(
  env: NodeJS.ProcessEnv = process.env,
  deps: HomeRenameDeps = {},
): Promise<HomeRenameOutcome> {
  const names: Names = deps.names ?? NAMES;
  const requested = resolveJinnHome(env);
  const outcome = await renameHomeIfNeeded(requested, deps);
  if (path.resolve(outcome.home) !== path.resolve(requested) || readEnv(env, "HOME") !== undefined) {
    setEnv(env, "HOME", outcome.home, names);
  }
  const instance = readEnv(env, "INSTANCE");
  if (instance !== undefined && currentInstanceName(instance, names) !== instance) {
    setEnv(env, "INSTANCE", currentInstanceName(instance, names), names);
  }
  return outcome;
}
