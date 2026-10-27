import { claudeProfileFromDir, resolveEmployeeClaudeProfile, type ClaudeProfile } from "../shared/claude-profile.js";
import {
  accountForEmployee, claudeAccountKey, DEFAULT_CLAUDE_ACCOUNT, employeeClaudeAccount, isClaudeAccount, isRemoteClaudeAccount,
} from "../shared/engine-account.js";
import type { Employee, Session } from "../shared/types.js";

/** The parts of a session this module reads; the transport meta and the chosen
 *  profile are optional so a caller holding only an id-and-employee view can ask too. */
type SessionView = { employee?: string | null; transportMeta?: Session["transportMeta"]; claudeConfigDir?: string | null };

/**
 * Which Claude account a session runs on now (spec FR-079).
 *
 * A session runs on its own account (the declared profile it was started on,
 * else its employee's), unless a rate limit has moved it
 * onto another Claude account: then the `engineOverride` record names the
 * substitute account and its profile directory, and everything that runs or
 * reads the session's Claude state (the turn, the terminal attach, the
 * transcript readers, the signed-in check, the per-account thread id) follows
 * it, so a second turn inside the override window resumes the substitute's
 * thread on the substitute's profile. The record stays until the turn-start
 * revert (`maybeRevertEngineOverride`) lifts it once its `until` has passed,
 * which is what hands the session back to its own account and thread: the profile
 * it was started on, not its employee's.
 *
 * Account substitution is local only in v1: a remote employee's substitute is
 * an engine on its host, never another account.
 */

export interface AccountOverride {
  originalAccount: string;
  substituteAccount: string;
  /** The substitute's profile directory; null for the default account. */
  substituteConfigDir: string | null;
}

/** The account half of a session's override record, when it names one. */
export function accountOverride(session: SessionView): AccountOverride | undefined {
  const record = (session.transportMeta as Record<string, unknown> | null | undefined)?.engineOverride as Record<string, unknown> | undefined;
  const substitute = record?.substituteAccount;
  if (typeof substitute !== "string" || !isClaudeAccount(substitute)) return undefined;
  return {
    originalAccount: typeof record?.originalAccount === "string" ? record.originalAccount : DEFAULT_CLAUDE_ACCOUNT,
    substituteAccount: substitute,
    substituteConfigDir: typeof record?.substituteConfigDir === "string" ? record.substituteConfigDir : null,
  };
}

/**
 * The declared account the session was started on (sessions/primary-profile.ts),
 * which replaces its employee's own login as the account it "belongs" to. A
 * remote employee runs on its host's login, so a row that names a profile and
 * later turned remote ignores it.
 */
function chosenProfile(session: SessionView | null | undefined, employee?: Pick<Employee, "remoteHost"> | null): Exclude<ClaudeProfile, null> | undefined {
  const dir = session?.claudeConfigDir;
  if (!dir || employee?.remoteHost) return undefined;
  return claudeProfileFromDir(dir);
}

/** The session's own Claude account: the profile it was started on, else its employee's, else the default. */
export function ownClaudeAccount(session: SessionView): string {
  const employeeAccount = session.employee ? employeeClaudeAccount(session.employee) : DEFAULT_CLAUDE_ACCOUNT;
  if (!session.claudeConfigDir || isRemoteClaudeAccount(employeeAccount)) return employeeAccount;
  return claudeAccountKey(claudeProfileFromDir(session.claudeConfigDir));
}

/** The local Claude profile the session's own turns run as when no override stands: the one it was started on, else its employee's. */
export function ownClaudeProfile(
  session: SessionView | null | undefined,
  employee: Pick<Employee, "claudeConfigDir" | "remoteHost"> | null | undefined,
): ClaudeProfile {
  return chosenProfile(session, employee) ?? resolveEmployeeClaudeProfile(employee);
}

/** The account key of `ownClaudeProfile`, from the roster record in hand: a remote employee's own login, else the profile's. */
export function ownClaudeAccountOf(session: SessionView | null | undefined, employee: Employee | undefined): string {
  const chosen = chosenProfile(session, employee);
  return chosen ? claudeAccountKey(chosen) : accountForEmployee(employee, "claude");
}

/** The Claude account the session's turns run on now. */
export function currentClaudeAccount(session: SessionView): string {
  return accountOverride(session)?.substituteAccount ?? ownClaudeAccount(session);
}

/** The local Claude profile the session's turns run as now: the substitute
 *  account's while an account override stands, else its own (the profile it was
 *  started on, or its employee's). */
export function sessionClaudeProfile(
  session: SessionView | null | undefined,
  employee: Pick<Employee, "claudeConfigDir" | "remoteHost"> | null | undefined,
): ClaudeProfile {
  const override = session ? accountOverride(session) : undefined;
  if (override && !employee?.remoteHost) {
    return override.substituteConfigDir ? claudeProfileFromDir(override.substituteConfigDir) : null;
  }
  return ownClaudeProfile(session, employee);
}

/**
 * The `engineSessions` slot a thread id is kept under (FR-079). Claude's slot
 * is the session's current account: `claude` for the default account, as
 * before accounts, and the account key for any other, so a substitute account
 * never overwrites the original account's thread id. Every other engine keeps
 * its engine name.
 */
export function threadSlot(session: SessionView, engine: string): string {
  return engine === "claude" ? currentClaudeAccount(session) : engine;
}

/**
 * A row written before Claude's slot was keyed by account: a named-profile or
 * remote employee's own thread sits under `claude`. Read it there while the row
 * has no account-keyed slot yet and no account override stands; the first
 * account-keyed write ends the fallback, so a `claude` slot later holding the
 * default account's substitute thread is never mistaken for the session's own.
 */
export function legacyThreadRef<T>(session: SessionView & { engineSessions?: Record<string, T> | null }, engine: string): T | undefined {
  if (engine !== "claude" || threadSlot(session, engine) === engine || accountOverride(session)) return undefined;
  const refs = session.engineSessions ?? {};
  if (Object.keys(refs).some((key) => key !== DEFAULT_CLAUDE_ACCOUNT && isClaudeAccount(key))) return undefined;
  return refs.claude;
}

/**
 * The refs after writing `slot`, with a legacy `claude` slot MOVED to the
 * account slot rather than copied: left in place it would read as the default
 * account's thread the moment an override pointed the session there, and a
 * substitute on the default profile would try to resume the employee's own
 * conversation.
 */
export function withLegacySlotMoved<T>(
  session: SessionView & { engineSessions?: Record<string, T> | null },
  engine: string,
  refs: Record<string, T>,
): Record<string, T> {
  if (legacyThreadRef(session, engine) === undefined) return refs;
  const { claude: _legacy, ...rest } = refs;
  return rest as Record<string, T>;
}

/** The session as it reads with no account override: its own account's slots. */
export function withoutAccountOverride<S extends SessionView>(session: S): S {
  const meta = session.transportMeta && typeof session.transportMeta === "object" ? { ...(session.transportMeta as Record<string, unknown>) } : {};
  delete meta.engineOverride;
  return { ...session, transportMeta: meta as Session["transportMeta"] };
}
