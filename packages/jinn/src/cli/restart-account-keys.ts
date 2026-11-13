import { opencodeAccountKeyEnvironment } from "../shared/child-env.js";
import { stagedOpencodeAccounts } from "../shared/opencode-accounts-config.js";

type KeyConfig = Parameters<typeof stagedOpencodeAccounts>[0];

/** The warning for a restart this process performs itself (the detached helper), or null when every declared account's key will reach the restarted gateway. The helper hands down this process's environment, so a key that is in neither the key vault nor the environment (a restart from inside a session, whose environment never held it) is lost: the restarted gateway runs without it. */
export function missingAccountKeyWarning(config: KeyConfig, env: Readonly<Record<string, string | undefined>> = opencodeAccountKeyEnvironment()): string | null {
  const missing = stagedOpencodeAccounts(config)
    .filter((account) => account.keyEnv !== undefined && (env[account.keyEnv] ?? "").trim() === "")
    .map((account) => `${account.name} (${account.keyEnv})`);
  if (missing.length === 0) return null;
  return `Warning: this shell has no key for OpenCode account${missing.length === 1 ? "" : "s"} ${missing.join(", ")}, so the restarted gateway will run without ${missing.length === 1 ? "it" : "them"}. Restart with POST /api/system/restart (the running gateway keeps its keys), or run "jinn restart" from the operator's shell, where the key variables are set.`;
}
