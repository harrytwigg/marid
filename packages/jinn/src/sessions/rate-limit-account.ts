import { resolveEmployeeClaudeProfile, type ClaudeProfile } from "../shared/claude-profile.js";
import { accountForEmployee, DEFAULT_CLAUDE_ACCOUNT } from "../shared/engine-account.js";
import { recordEngineUnavailable, type EngineHealthReading } from "../shared/engine-health.js";
import { recordClaudeRateLimit } from "../shared/usageAwareness.js";
import type { Employee, Session } from "../shared/types.js";
import { accountOverride, sessionClaudeProfile } from "./session-account.js";

export { resolveEmployeeClaudeProfile };

/**
 * Which account a rate-limited turn ran on (FR-055, FR-070): the session's
 * current Claude account (its employee's, or the substitute account an
 * override has moved it onto), a remote employee's own login, or the engine's
 * single account for every other engine. Its limit is recorded under that key,
 * so it holds back only that account's sessions.
 */
export function rateLimitAccount(
  engine: string,
  employee: Employee | undefined,
  session?: Pick<Session, "transportMeta">,
): { claudeProfile: ClaudeProfile; account: string } {
  if (engine !== "claude") return { claudeProfile: null, account: engine };
  const override = session && !employee?.remoteHost ? accountOverride(session) : undefined;
  if (override) return { claudeProfile: sessionClaudeProfile(session, employee), account: override.substituteAccount };
  return { claudeProfile: resolveEmployeeClaudeProfile(employee), account: accountForEmployee(employee, "claude") };
}

/** Record a usage limit for the account: the generic record both chain walkers
 *  read, and Claude's own memory, which answers a different question. */
export function recordAccountRateLimit(account: string, engine: string, engineLabel: string, resetsAt: number | undefined): void {
  recordEngineUnavailable(account, `${engineLabel} usage limit`, resetsAt);
  if (engine === "claude") recordClaudeRateLimit(resetsAt, account);
}

/**
 * Health as a substitute chosen for this employee reads it. A substitute that
 * lands on claude runs on the employee's own account when it has one (a local
 * named profile, or a remote employee's own login), so that account's record
 * stands in for the default account's `claude`.
 */
export function substituteHealth(health: EngineHealthReading, employee: Employee | undefined): EngineHealthReading {
  const account = accountForEmployee(employee, "claude");
  if (account === DEFAULT_CLAUDE_ACCOUNT) return health;
  const { claude: _defaultAccount, ...rest } = health;
  const own = health[account];
  return own ? { ...rest, claude: own } : rest;
}
