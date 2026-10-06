import { resolveEmployeeClaudeProfile, type ClaudeProfile } from "../shared/claude-profile.js";
import { claudeAccountKey, engineAccountKey } from "../shared/engine-account.js";
import { recordEngineUnavailable, type EngineHealthReading } from "../shared/engine-health.js";
import { recordClaudeRateLimit } from "../shared/usageAwareness.js";
import type { Employee } from "../shared/types.js";

export { resolveEmployeeClaudeProfile };

/**
 * Which account a rate-limited turn ran on. A local named Claude profile is its
 * own account: its limit is recorded under its own key, and until accounts get
 * fallback chains of their own it has none, so it waits for its own reset
 * (FR-055, FR-056). Every other session keeps its engine's account.
 */
export function rateLimitAccount(engine: string, employee: Employee | undefined): { claudeProfile: ClaudeProfile; account: string } {
  const claudeProfile = engine === "claude" ? resolveEmployeeClaudeProfile(employee) : null;
  return { claudeProfile, account: engineAccountKey(engine, claudeProfile) };
}

/** Record a usage limit for the account: the generic record both chain walkers
 *  read, and Claude's own memory, which answers a different question. */
export function recordAccountRateLimit(account: string, engine: string, engineLabel: string, resetsAt: number | undefined): void {
  recordEngineUnavailable(account, `${engineLabel} usage limit`, resetsAt);
  if (engine === "claude") recordClaudeRateLimit(resetsAt, account);
}

/**
 * Health as a substitute chosen for this employee reads it. A substitute that
 * lands on claude runs on the employee's own profile when it has one, so that
 * account's record stands in for the default account's `claude`.
 */
export function substituteHealth(health: EngineHealthReading, employee: Employee | undefined): EngineHealthReading {
  const profile = resolveEmployeeClaudeProfile(employee);
  if (!profile) return health;
  const { claude: _defaultAccount, ...rest } = health;
  const own = health[claudeAccountKey(profile)];
  return own ? { ...rest, claude: own } : rest;
}
