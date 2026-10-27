import { declaredAccountByKey, declaredRemoteAccountByKey } from "../shared/claude-accounts-config.js";
import { resolveEmployeeClaudeProfile } from "../shared/claude-profile.js";
import { accountForEmployee, DEFAULT_CLAUDE_ACCOUNT } from "../shared/engine-account.js";
import { resolveRemoteClaudeConfigDir } from "../shared/remote-target.js";
import type { ResolvedFallbackLink } from "../shared/fallback-chain-wire.js";
import type { ChooseSubstituteInput, SubstituteChoice } from "./rate-limit-substitute.js";
import { rateLimitAccount } from "./rate-limit-account.js";
import { accountOverride } from "./session-account.js";
import { fallbackModelMapOf } from "./substitute-filters.js";

/**
 * What it takes to run a chain link: the Claude profile, and for a link that is
 * another Claude account the swap the override records. Other engines need
 * neither. On a remote host the only Claude link that is another account is a
 * remote account declared on the session's own `user@host`, and it needs no local
 * profile: the swap carries the directory on that host.
 */

type Launch = Pick<SubstituteChoice, "claudeProfile" | "accounts">;

/** The swap that keeps a model change on the account the session already stands on. */
function standingAccountSwap(input: ChooseSubstituteInput): SubstituteChoice["accounts"] {
  const standing = accountOverride(input.session);
  return standing
    ? { original: standing.originalAccount, substitute: standing.substituteAccount, substituteConfigDir: standing.substituteConfigDir }
    : undefined;
}

/** A local Claude session's link: another declared account (or the default one), or another model on the account it stands on. */
function accountLaunch(input: ChooseSubstituteInput, link: ResolvedFallbackLink): Launch {
  // The account the turn ran on keeps the profile it ran as, declared or not.
  if (link.account === input.account) {
    return { claudeProfile: rateLimitAccount("claude", input.employee, input.session).claudeProfile, accounts: standingAccountSwap(input) };
  }
  const profile = link.account === DEFAULT_CLAUDE_ACCOUNT ? null : declaredAccountByKey(input.config, link.account)?.profile ?? null;
  return {
    claudeProfile: profile,
    accounts: { original: input.account, substitute: link.account, substituteConfigDir: profile?.dir ?? null, fallbackModelMap: fallbackModelMapOf(input.config, input.account) },
  };
}

/** A Claude link reached from another engine: the employee's own profile, unless the link names one (then it is that account, as a swap, so its thread has its own slot). */
function engineLaunch(input: ChooseSubstituteInput, link: ResolvedFallbackLink): Launch {
  if (link.profile === undefined) return { claudeProfile: resolveEmployeeClaudeProfile(input.employee) };
  const profile = declaredAccountByKey(input.config, link.account)?.profile ?? null;
  const original = accountForEmployee(input.employee, "claude");
  return { claudeProfile: profile, accounts: { original, substitute: link.account, substituteConfigDir: profile?.dir ?? null } };
}

/**
 * A remote session's Claude link. The account it stands on keeps the swap it holds. Any other account
 * it can run as on its host is a swap onto that account's directory there: a declared remote account,
 * or, from a substitute, back onto the employee's own login (its own directory, null for the host's
 * default profile). That way the override always names the account the turn runs as, so the thread it
 * resumes is that account's and never another's.
 */
function remoteLaunch(input: ChooseSubstituteInput, link: ResolvedFallbackLink): Launch {
  if (link.account === input.account) {
    const standing = standingAccountSwap(input);
    return { claudeProfile: null, ...(standing ? { accounts: standing } : {}) };
  }
  const own = accountForEmployee(input.employee, "claude");
  const dir = link.account === own
    ? resolveRemoteClaudeConfigDir(input.remoteTarget, input.config.remote) ?? null
    : declaredRemoteAccountByKey(input.config, link.account)?.configDir;
  if (dir === undefined) return { claudeProfile: null };
  return { claudeProfile: null, accounts: { original: input.account, substitute: link.account, substituteConfigDir: dir } };
}

export function launchFor(input: ChooseSubstituteInput, accountMode: boolean, link: ResolvedFallbackLink): Launch {
  if (link.engine !== "claude") return { claudeProfile: null };
  if (input.remote) return remoteLaunch(input, link);
  return accountMode ? accountLaunch(input, link) : engineLaunch(input, link);
}
