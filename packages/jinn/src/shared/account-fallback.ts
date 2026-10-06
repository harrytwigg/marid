import { chainEntryAccount, declaredAccountByKey } from "./claude-accounts-config.js";
import { DEFAULT_CLAUDE_ACCOUNT, isClaudeAccount } from "./engine-account.js";
import { isEngineExhausted, type EngineHealthReading } from "./engine-health.js";
import { isKnownEngine, type EngineName } from "./models.js";
import type { JinnConfig } from "./types.js";

/**
 * Fallback chains walked per account (spec FR-079), on the existing
 * `engines.<engine>.fallback` mechanism, as if each Claude account were its
 * own Claude installation:
 *
 * - the default account's chain is `engines.claude.fallback`, unchanged;
 * - a declared account's chain is `engines.claude.accounts.<name>.fallback`;
 * - an undeclared named profile, or a declared one with no `fallback`, has
 *   none: it waits for its own reset (FR-056);
 * - every other engine's chain is its own `fallback`, as before.
 *
 * An entry is an engine name, `claude` (the default account) or
 * `claude:<name>` (a declared account). Like the engine walker, it continues
 * through the chain of every candidate it rejects, with a visited set, so the
 * cycles validation tolerates are safe.
 */

/** Where a substitute runs: an engine, and the account on it. For every engine
 *  but Claude the account is the engine's name. */
export interface FallbackTarget {
  engine: EngineName;
  account: string;
}

function chainFor(config: JinnConfig, account: string): string[] {
  if (account === DEFAULT_CLAUDE_ACCOUNT) return config.engines.claude?.fallback ?? [];
  if (isClaudeAccount(account)) return declaredAccountByKey(config, account)?.fallback ?? [];
  return config.engines[account as EngineName]?.fallback ?? [];
}

function targetFor(config: JinnConfig, entry: string): FallbackTarget | undefined {
  const account = chainEntryAccount(config, entry);
  if (account === undefined) return undefined;
  if (isClaudeAccount(account)) return { engine: "claude", account };
  return isKnownEngine(account) ? { engine: account, account } : undefined;
}

export interface AccountFallbackOptions {
  /** Only Claude-account entries apply: a session whose working layout is
   *  Claude's cannot move to another engine (FR-026a). */
  accountsOnly?: boolean;
}

/** The first target in `from`'s chain that `isUsable` accepts, walking on
 *  through the chain of each one it rejects. */
export function resolveAccountFallback(
  config: JinnConfig,
  from: string,
  isUsable: (target: FallbackTarget) => boolean,
  options: AccountFallbackOptions = {},
): FallbackTarget | null {
  const visited = new Set<string>([from]);
  const queue = [...chainFor(config, from)];
  for (let i = 0; i < queue.length; i++) {
    const target = targetFor(config, queue[i]);
    if (!target || visited.has(target.account)) continue;
    visited.add(target.account);
    const allowed = !options.accountsOnly || target.engine === "claude";
    if (allowed && isUsable(target)) return target;
    queue.push(...chainFor(config, target.account));
  }
  return null;
}

/** The first usable target whose account has not run out, keyed by account in
 *  the health store; walked again without health when health leaves nothing,
 *  as the engine walker does, so a stale record can reorder a chain but never
 *  empty one. */
export function resolveHealthyAccountFallback(
  config: JinnConfig,
  from: string,
  isUsable: (target: FallbackTarget) => boolean,
  health: EngineHealthReading,
  options: AccountFallbackOptions = {},
): FallbackTarget | null {
  return resolveAccountFallback(config, from, (target) => isUsable(target) && !isEngineExhausted(health, target.account), options)
    ?? resolveAccountFallback(config, from, isUsable, options);
}

/** Whether an account has a chain of its own to walk: the default account and
 *  every non-Claude engine always do (it may be empty); a named Claude account
 *  only when it is declared. */
export function accountHasChain(config: JinnConfig, account: string): boolean {
  if (!isClaudeAccount(account) || account === DEFAULT_CLAUDE_ACCOUNT) return true;
  return declaredAccountByKey(config, account) !== undefined;
}
