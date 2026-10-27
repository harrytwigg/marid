import { resolveEmployeeClaudeProfile, type ClaudeProfile } from "../shared/claude-profile.js";
import { DEFAULT_CLAUDE_ACCOUNT, isRemoteClaudeAccount } from "../shared/engine-account.js";
import { recordEngineUnavailable, type EngineHealthReading } from "../shared/engine-health.js";
import { recordClaudeRateLimit } from "../shared/usageAwareness.js";
import type { Employee, Session } from "../shared/types.js";
import { accountOverride, ownClaudeAccountOf, ownClaudeProfile, sessionClaudeProfile } from "./session-account.js";

export { resolveEmployeeClaudeProfile };

/**
 * Which account a rate-limited turn ran on (FR-055, FR-070): the session's
 * current Claude account (the profile it was started on, else its employee's,
 * or the substitute account an override has moved it onto, a remote account for
 * a remote employee), a remote employee's own login, or the engine's
 * single account for every other engine. Its limit is recorded under that key,
 * so it holds back only that account's sessions.
 */
export function rateLimitAccount(
  engine: string,
  employee: Employee | undefined,
  session?: Pick<Session, "transportMeta" | "claudeConfigDir">,
): { claudeProfile: ClaudeProfile; account: string } {
  if (engine !== "claude") return { claudeProfile: null, account: engine };
  const standing = session ? accountOverride(session) : undefined;
  // A remote session stands on a substitute account only when it is a remote one; the gateway's profiles are not on its host.
  const override = standing && (!employee?.remoteHost || isRemoteClaudeAccount(standing.substituteAccount)) ? standing : undefined;
  if (override) return { claudeProfile: sessionClaudeProfile(session, employee), account: override.substituteAccount };
  return { claudeProfile: ownClaudeProfile(session, employee), account: ownClaudeAccountOf(session, employee) };
}

/** Record a usage limit for the account: the generic record the chain walk
 *  reads, and Claude's own memory, which answers a different question. The
 *  record is kept under `healthKey` (the account's by default): an opencode
 *  model's provider, so one provider's limit does not hold back the others. */
export function recordAccountRateLimit(account: string, engine: string, engineLabel: string, resetsAt: number | undefined, healthKey: string = account): void {
  recordEngineUnavailable(healthKey, `${engineLabel} usage limit`, resetsAt);
  if (engine === "claude") recordClaudeRateLimit(resetsAt, account);
}

/**
 * Health as a substitute chosen for this session reads it. A substitute that
 * lands on claude runs on the session's own account when it has one (the profile
 * it was started on, an employee's local named profile, or a remote employee's
 * own login), so that account's record stands in for the default account's `claude`.
 */
export function substituteHealth(health: EngineHealthReading, employee: Employee | undefined, session?: Pick<Session, "claudeConfigDir">): EngineHealthReading {
  const account = ownClaudeAccountOf(session, employee);
  if (account === DEFAULT_CLAUDE_ACCOUNT) return health;
  const { claude: _defaultAccount, ...rest } = health;
  const own = health[account];
  return own ? { ...rest, claude: own } : rest;
}
