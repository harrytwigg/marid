import { declaredAccountByKey } from "../shared/claude-accounts-config.js";
import { DEFAULT_CLAUDE_ACCOUNT } from "../shared/engine-account.js";
import type { ResolvedFallbackLink } from "../shared/fallback-chain-wire.js";
import type { ChooseSubstituteInput, SubstituteChoice } from "./rate-limit-substitute.js";
import { rateLimitAccount } from "./rate-limit-account.js";
import { accountOverride, ownClaudeAccountOf, ownClaudeProfile } from "./session-account.js";
import { fallbackModelMapOf } from "./substitute-filters.js";

/**
 * What it takes to run a chain link: the Claude profile, and for a link that is
 * another Claude account the swap the override records. Other engines need
 * neither, and nothing but a local Claude link ever does.
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
  if (link.profile === undefined) return { claudeProfile: ownClaudeProfile(input.session, input.employee) };
  const profile = declaredAccountByKey(input.config, link.account)?.profile ?? null;
  const original = ownClaudeAccountOf(input.session, input.employee);
  return { claudeProfile: profile, accounts: { original, substitute: link.account, substituteConfigDir: profile?.dir ?? null } };
}

export function launchFor(input: ChooseSubstituteInput, accountMode: boolean, link: ResolvedFallbackLink): Launch {
  if (link.engine !== "claude" || input.remote) return { claudeProfile: null };
  return accountMode ? accountLaunch(input, link) : engineLaunch(input, link);
}
