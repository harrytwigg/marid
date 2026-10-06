import { canonicalClaudeConfigDir, claudeProfileKey, resolveEmployeeClaudeProfile, type ClaudeProfile } from "./claude-profile.js";
import { isRemoteTarget, resolveRemoteClaudeConfigDir } from "./remote-target.js";
import type { Employee, RemoteExecutionConfig, RemoteTarget } from "./types.js";

/**
 * An account is an engine plus the login it runs as (spec FR-070):
 *
 * - `claude`: the gateway's own Claude profile, exactly as before accounts;
 * - `claude:<profile key>`: a local named profile (`claudeConfigDir`);
 * - `claude@<user>@<host>`, or `claude@<host>` with no `remoteUser`, plus
 *   `:<profile key>` when the remote employee names a profile: a login on a
 *   remote host. The user is part of it, because two users on one host are
 *   two logins;
 * - every other engine keeps one account, named after its engine.
 *
 * Every per-account store (engine health, the rate-limit memory, the usage
 * history, the board walk's readings) keys on this, so the default account's
 * keys never change and one account's limit or outage never holds back
 * another's sessions. Departments play no part: two departments sharing an
 * account share its limits.
 */
export const DEFAULT_CLAUDE_ACCOUNT = "claude";

export function claudeAccountKey(profile: ClaudeProfile | undefined): string {
  return profile ? `${DEFAULT_CLAUDE_ACCOUNT}:${profile.key}` : DEFAULT_CLAUDE_ACCOUNT;
}

/** The account a turn on `engine` runs as, given the session's local profile. */
export function engineAccountKey(engine: string, profile: ClaudeProfile | undefined): string {
  return engine === "claude" ? claudeAccountKey(profile) : engine;
}

/** A remote Claude login: the host, the user it signs in as, and the profile
 *  directory on that host when one is named. */
export function remoteClaudeAccountKey(target: { remoteHost: string; remoteUser?: string }, configDir: string | undefined): string {
  const user = typeof target.remoteUser === "string" ? target.remoteUser.trim() : "";
  const host = target.remoteHost.trim();
  const base = user ? `${DEFAULT_CLAUDE_ACCOUNT}@${user}@${host}` : `${DEFAULT_CLAUDE_ACCOUNT}@${host}`;
  return configDir ? `${base}:${claudeProfileKey(canonicalClaudeConfigDir(configDir))}` : base;
}

/** The instance-wide `remote` block, registered by the gateway at boot, so a
 *  remote employee that inherits `remote.claudeConfigDir` is keyed on the
 *  profile it actually runs as. With nothing registered only the employee's
 *  own `remoteClaudeConfigDir` counts. */
let remoteDefaults: () => RemoteExecutionConfig | undefined = () => undefined;

export function registerRemoteAccountDefaults(source: () => RemoteExecutionConfig | undefined): void {
  remoteDefaults = source;
}

/** The account a remote Claude target signs in as, with the instance-wide
 *  profile directory applied when the target names none. */
export function remoteAccountForTarget(target: RemoteTarget & { remoteHost: string }): string {
  let remote: RemoteExecutionConfig | undefined;
  try {
    remote = remoteDefaults();
  } catch { /* an unreadable config keys on the target's own profile only */ }
  return remoteClaudeAccountKey(target, resolveRemoteClaudeConfigDir(target, remote));
}

/** The account an employee's sessions on `engine` run as. */
export function accountForEmployee(employee: Employee | undefined, engine: string = employee?.engine ?? "claude"): string {
  if (engine !== "claude") return engine;
  if (employee && isRemoteTarget(employee)) return remoteAccountForTarget(employee);
  return claudeAccountKey(resolveEmployeeClaudeProfile(employee));
}

export function isDefaultClaudeAccount(account: string | undefined): boolean {
  return account === undefined || account === DEFAULT_CLAUDE_ACCOUNT;
}

/** A login on another machine, which the gateway reads over SSH (FR-072). */
export function isRemoteClaudeAccount(account: string): boolean {
  return account.startsWith(`${DEFAULT_CLAUDE_ACCOUNT}@`);
}

/** A Claude account of any kind: the default, a local profile or a remote login. */
export function isClaudeAccount(account: string): boolean {
  return account === DEFAULT_CLAUDE_ACCOUNT || account.startsWith(`${DEFAULT_CLAUDE_ACCOUNT}:`) || isRemoteClaudeAccount(account);
}

/** The engine an account belongs to. */
export function accountEngine(account: string): string {
  return isClaudeAccount(account) ? "claude" : account;
}

/** Which Claude account an employee's sessions run as, by name. The gateway
 *  registers this at boot from the roster; with nothing registered (a unit
 *  test, a single-account instance before boot) every employee is the default
 *  account. */
let employeeAccount: ((name: string) => string | undefined) | undefined;

export function registerEmployeeAccountResolver(resolver: ((name: string) => string | undefined) | undefined): void {
  employeeAccount = resolver;
}

export function employeeClaudeAccount(name: string): string {
  try {
    return employeeAccount?.(name) ?? DEFAULT_CLAUDE_ACCOUNT;
  } catch {
    return DEFAULT_CLAUDE_ACCOUNT;
  }
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

/** The account a session's Claude turns run on now, including a live account
 *  substitution. Undefined for a session the registry does not know. */
export function sessionAccountKey(jinnSessionId: string): string | undefined {
  return sessionAccount?.(jinnSessionId);
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

/** Whether a snapshot written by this session is `account`'s reading. */
export function isAccountSession(jinnSessionId: string, account: string): boolean {
  return isDefaultClaudeAccount(account)
    ? isDefaultAccountSession(jinnSessionId)
    : sessionAccount?.(jinnSessionId) === account;
}
