import { declaredAccountByKey, declaredClaudeAccounts } from "./claude-accounts-config.js";
import { DEFAULT_CLAUDE_ACCOUNT } from "./engine-account.js";
import type { FallbackLink } from "./fallback-chain-wire.js";
import type { JinnConfig } from "./types.js";

/** Where a link runs and what a target is, from config alone: the light half of the resolver, which the roster loader needs without the session machinery. */

/**
 * The account a link runs as: a Claude link on its declared profile's account; any other link on its engine.
 * An unprofiled Claude link runs as the login the subject's Claude turns run as, `unprofiled`: the default
 * account unless the subject is a remote employee (its remote login) or one on a named profile.
 */
export function linkAccount(link: FallbackLink, config: JinnConfig, unprofiled: string = DEFAULT_CLAUDE_ACCOUNT): string {
  if (link.engine !== "claude") return link.engine;
  if (link.profile === undefined) return unprofiled;
  const declared = declaredClaudeAccounts(config).find((account) => account.name === link.profile);
  return declared?.key ?? `${DEFAULT_CLAUDE_ACCOUNT}:${link.profile}`;
}

/** The target as a link: engine, the declared profile its Claude account matches (else none), and the model. */
export function ownTargetLink(config: JinnConfig, target: { engine: string; model?: string | null; account?: string }): FallbackLink {
  const profile = target.engine === "claude" && target.account !== undefined ? declaredAccountByKey(config, target.account)?.name : undefined;
  return { engine: target.engine, ...(profile === undefined ? {} : { profile }), ...(target.model ? { model: target.model } : {}) };
}

/** Whether the entry wrote a model itself, as opposed to leaving it to the session's own or a `fallbackModelMap` translation. The written model is the link's choice. */
export function linkModelWritten(link: { written?: FallbackLink }): boolean {
  return link.written?.model !== undefined;
}
