import { resolveEmployeeClaudeProfile, type ClaudeProfile } from "./claude-profile.js";
import type { Employee } from "./types.js";

/**
 * An account is an engine plus the login it runs as (spec FR-070):
 *
 * - `claude`: the gateway's own Claude profile, exactly as before accounts;
 * - `claude:<profile key>`: a local named profile (`claudeConfigDir`);
 * - every other engine, and for now every remote employee, keeps one account
 *   named after its engine. Remote accounts get their own keys later; until
 *   then a remote session's state is keyed exactly as it always was.
 *
 * Every per-account store (engine health, the rate-limit memory, the auth
 * outage ledger) keys on this, so the default account's keys never change and
 * one account's limit or outage never holds back another's sessions.
 */
export const DEFAULT_CLAUDE_ACCOUNT = "claude";

export function claudeAccountKey(profile: ClaudeProfile | undefined): string {
  return profile ? `${DEFAULT_CLAUDE_ACCOUNT}:${profile.key}` : DEFAULT_CLAUDE_ACCOUNT;
}

/** The account a turn on `engine` runs as, given the session's local profile. */
export function engineAccountKey(engine: string, profile: ClaudeProfile | undefined): string {
  return engine === "claude" ? claudeAccountKey(profile) : engine;
}

/** The account an employee's sessions on `engine` run as. */
export function accountForEmployee(employee: Employee | undefined, engine: string = employee?.engine ?? "claude"): string {
  return engineAccountKey(engine, resolveEmployeeClaudeProfile(employee));
}

export function isDefaultClaudeAccount(account: string | undefined): boolean {
  return account === undefined || account === DEFAULT_CLAUDE_ACCOUNT;
}

/**
 * Which account a Jinn session's Claude turns run as, by session id. The
 * gateway registers this at boot (it needs the session registry and the
 * roster, which this module cannot import). With nothing registered every
 * session is the default account, which is how a single-account instance and
 * a unit test without a roster both read.
 */
type SessionAccountResolver = (jinnSessionId: string) => string | undefined;
let sessionAccount: SessionAccountResolver | undefined;

export function registerSessionAccountResolver(resolver: SessionAccountResolver | undefined): void {
  sessionAccount = resolver;
}

/**
 * Whether a status-line snapshot written by this session counts as the
 * default account's reading. Every local session writes into one directory, so
 * the Limits card, the backoff reset time and the board walk must skip a named
 * profile's snapshots, or a friend's windows would read as the operator's. A
 * session the registry no longer knows counts as the default account, as every
 * snapshot did before accounts.
 */
export function isDefaultAccountSession(jinnSessionId: string): boolean {
  return isDefaultClaudeAccount(sessionAccount?.(jinnSessionId));
}
