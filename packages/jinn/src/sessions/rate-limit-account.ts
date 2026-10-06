import { resolveEmployeeClaudeProfile, type ClaudeProfile } from "../shared/claude-profile.js";
import { engineAccountKey } from "../shared/engine-account.js";
import { recordEngineUnavailable } from "../shared/engine-health.js";
import { recordClaudeRateLimit } from "../shared/usageAwareness.js";
import type { Employee } from "../shared/types.js";

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
