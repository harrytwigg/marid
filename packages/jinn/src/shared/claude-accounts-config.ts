import path from "node:path";
import { canonicalClaudeConfigDir, claudeProfileFromDir, validateEmployeeClaudeConfigDir, type ClaudeProfile } from "./claude-profile.js";
import { claudeAccountKey, DEFAULT_CLAUDE_ACCOUNT, remoteClaudeAccountKey } from "./engine-account.js";
import { ENGINE_NAMES } from "./models.js";
import type { DuplicateTolerance } from "./fallback-chain-load.js";
import { fallbackChainProblems, type FallbackChainEntry } from "./fallback-chain-wire.js";
import { sshDestination, validateDestination } from "./remote-target.js";

/** What an account is validated with beyond its own entry. */
interface AccountValidation {
  jinnHome: string | undefined;
  onDuplicate: DuplicateTolerance | undefined;
}

/**
 * Declared Claude accounts (spec FR-079): `engines.claude.accounts.<name>`,
 * each a local profile with its own fallback chain, as if each were its own
 * Claude installation.
 *
 * ```yaml
 * engines:
 *   claude:
 *     fallback: [codex]          # the default account's chain, unchanged
 *     accounts:
 *       friend:
 *         configDir: /Users/operator/.claude-friend
 *         fallback: []           # wait for its own reset
 * ```
 *
 * The name is only an alias and a label. It resolves to the account key
 * `claude:<profile key>` (FR-070), and every store keys on that, so renaming
 * an account in config orphans no health, history or limits.
 *
 * With `remoteHost` the account is a profile directory ON THAT HOST: a login a
 * remote employee on the same `user@host` can fall back to. It resolves to the
 * key such an employee on that directory has (`claude@<user>@<host>:<profile
 * key>`), and has no chain of its own: its employees write theirs.
 *
 * ```yaml
 *       spare:
 *         remoteHost: build-host
 *         remoteUser: me
 *         configDir: /home/me/.claude-b
 * ```
 */
export interface ClaudeAccountConfig {
  /** A directory on the gateway, or on `remoteHost` when that is set. */
  configDir: string;
  /** Set: the account is a login on this host (see above). */
  remoteHost?: string;
  /** The user it signs in as on `remoteHost`; absent: ssh's own default, as on an employee. */
  remoteUser?: string;
  /** This account's chain: `{engine, profile?, model?}` mappings, or the legacy
   *  strings (an engine name, `claude` for the default account, `claude:<name>`). */
  fallback?: FallbackChainEntry[];
  fallbackModelMap?: Record<string, string>;
}

export interface DeclaredClaudeAccount {
  name: string;
  key: string;
  profile: Exclude<ClaudeProfile, null>;
  fallback: FallbackChainEntry[] | undefined;
  fallbackModelMap: Record<string, string> | undefined;
}

/** A declared account on another host. */
export interface DeclaredRemoteClaudeAccount {
  name: string;
  /** `claude@<user>@<host>:<profile key>`: what a remote employee on this directory keys on. */
  key: string;
  remoteHost: string;
  remoteUser?: string;
  /** Canonical directory on the host. */
  configDir: string;
  /** ssh destination: `user@host`, or the bare host. */
  destination: string;
}

/** The `accounts` mapping under `engines.claude`, read loosely: config arrives
 *  as parsed YAML, and validation is what refuses a bad shape. */
function accountsSection(engines: unknown): Record<string, unknown> {
  const claude = (engines as { claude?: unknown } | undefined)?.claude;
  const accounts = (claude as { accounts?: unknown } | undefined)?.accounts;
  return accounts && typeof accounts === "object" && !Array.isArray(accounts) ? accounts as Record<string, unknown> : {};
}

/** The names under `engines.claude.accounts`, local and remote, valid or not: what a chain's `profile` is checked against. */
export function accountNames(engines: unknown): Set<string> {
  return new Set(Object.keys(accountsSection(engines)));
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Whether an entry names a host: such an account is a login there, not a local profile. */
function isRemoteEntry(entry: Partial<ClaudeAccountConfig> | null): boolean {
  return text(entry?.remoteHost) !== "";
}

/**
 * Every declared LOCAL account whose `configDir` is usable, in declaration
 * order. An account on another host is not one: the callers here are local
 * profile machinery (sign-in checks, profile directories, the local Limits
 * card). See {@link declaredRemoteClaudeAccounts}.
 */
export function declaredClaudeAccounts(config: { engines: unknown }): DeclaredClaudeAccount[] {
  const out: DeclaredClaudeAccount[] = [];
  for (const [name, raw] of Object.entries(accountsSection(config.engines))) {
    const entry = raw as Partial<ClaudeAccountConfig> | null;
    if (!entry || isRemoteEntry(entry)) continue;
    if (typeof entry.configDir !== "string" || !path.posix.isAbsolute(entry.configDir.trim())) continue;
    const profile = claudeProfileFromDir(entry.configDir);
    out.push({
      name,
      key: claudeAccountKey(profile),
      profile,
      fallback: Array.isArray(entry.fallback) ? entry.fallback : undefined,
      fallbackModelMap: entry.fallbackModelMap && typeof entry.fallbackModelMap === "object" ? entry.fallbackModelMap : undefined,
    });
  }
  return out;
}

/** Every declared account on another host whose host, user and directory are usable, in declaration order. */
export function declaredRemoteClaudeAccounts(config: { engines: unknown }): DeclaredRemoteClaudeAccount[] {
  const out: DeclaredRemoteClaudeAccount[] = [];
  for (const [name, raw] of Object.entries(accountsSection(config.engines))) {
    const entry = raw as Partial<ClaudeAccountConfig> | null;
    if (!entry || !isRemoteEntry(entry)) continue;
    const remoteHost = text(entry.remoteHost);
    const remoteUser = text(entry.remoteUser);
    const dir = text(entry.configDir);
    if (validateDestination(remoteHost, remoteUser) || !path.posix.isAbsolute(dir)) continue;
    const configDir = canonicalClaudeConfigDir(dir);
    const target = { remoteHost, ...(remoteUser ? { remoteUser } : {}) };
    out.push({ name, key: remoteClaudeAccountKey(target, configDir), ...target, configDir, destination: sshDestination(target) });
  }
  return out;
}

/** The declared remote account called `name`, if there is one. */
export function declaredRemoteAccountByName(config: { engines: unknown }, name: string): DeclaredRemoteClaudeAccount | undefined {
  return declaredRemoteClaudeAccounts(config).find((account) => account.name === name);
}

/** The declared remote account for an account key, if there is one. */
export function declaredRemoteAccountByKey(config: { engines: unknown }, key: string): DeclaredRemoteClaudeAccount | undefined {
  return declaredRemoteClaudeAccounts(config).find((account) => account.key === key);
}

/** The declared account for an account key, if one is declared. */
export function declaredAccountByKey(config: { engines: unknown }, key: string): DeclaredClaudeAccount | undefined {
  return declaredClaudeAccounts(config).find((account) => account.key === key);
}

/**
 * The account key a chain entry names: `claude` is the default account,
 * `claude:<name>` a declared one, anything else an engine. Undefined for an
 * account entry naming no declared account.
 */
export function chainEntryAccount(config: { engines: unknown }, entry: string): string | undefined {
  if (entry === DEFAULT_CLAUDE_ACCOUNT) return DEFAULT_CLAUDE_ACCOUNT;
  if (!entry.startsWith(`${DEFAULT_CLAUDE_ACCOUNT}:`)) return entry;
  const name = entry.slice(DEFAULT_CLAUDE_ACCOUNT.length + 1);
  return declaredClaudeAccounts(config).find((account) => account.name === name)?.key;
}

const ACCOUNT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function configDirProblems(where: string, configDir: unknown, seenDirs: Map<string, string>, name: string, jinnHome: string | undefined): string[] {
  if (typeof configDir !== "string") return [`${where}.configDir must be an absolute path`];
  const problems: string[] = [];
  const why = validateEmployeeClaudeConfigDir({ claudeConfigDir: configDir }, jinnHome);
  if (why) problems.push(`${where}: ${why.replace(/^claudeConfigDir/, "configDir")}`);
  const dir = canonicalClaudeConfigDir(configDir);
  const other = seenDirs.get(dir);
  if (other) problems.push(`${where}.configDir ${dir} is already account ${other}'s`);
  else seenDirs.set(dir, name);
  return problems;
}

/** A remote account's host and user, judged as an employee's remote target is, and the chain it may not have. */
function remoteHostProblems(where: string, entry: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (typeof entry.remoteHost !== "string") problems.push(`${where}.remoteHost must be a host name`);
  if (entry.remoteUser !== undefined && typeof entry.remoteUser !== "string") problems.push(`${where}.remoteUser must be a user name`);
  const bad = typeof entry.remoteHost === "string" ? validateDestination(text(entry.remoteHost), text(entry.remoteUser)) : undefined;
  if (bad) problems.push(`${where}: ${bad.error}`);
  if (entry.fallback !== undefined || entry.fallbackModelMap !== undefined) {
    problems.push(`${where}: a remote account has no chain of its own; write the chain on its employees' fallback`);
  }
  return problems;
}

/** A remote account's directory is on that host, so the gateway's own filesystem and instance home say nothing about it: it must be an absolute POSIX path, and its own on that `user@host`. */
function remoteDirProblems(where: string, entry: Record<string, unknown>, seenDirs: Map<string, string>, name: string): string[] {
  const dir = text(entry.configDir);
  const host = text(entry.remoteHost) || "the remote host";
  if (!dir) return [`${where}.configDir must be an absolute path on ${host}`];
  if (dir.startsWith("~")) return [`${where}.configDir "${dir}" must be an absolute path, not home-relative`];
  if (!path.posix.isAbsolute(dir)) return [`${where}.configDir "${dir}" must be an absolute path on ${host}`];
  const canonical = canonicalClaudeConfigDir(dir);
  const destination = sshDestination({ remoteHost: text(entry.remoteHost), remoteUser: text(entry.remoteUser) });
  const seen = `remote:${destination}:${canonical}`;
  const other = seenDirs.get(seen);
  if (other) return [`${where}.configDir ${canonical} is already account ${other}'s on ${destination}`];
  seenDirs.set(seen, name);
  return [];
}

/** A remote account's problems; a `remoteUser` with no host would silently be a local account. */
function remoteAccountProblems(where: string, entry: Record<string, unknown>, seenDirs: Map<string, string>, name: string): string[] {
  if (entry.remoteHost === undefined) return [`${where}.remoteUser is set but remoteHost is not: the account would silently be a local one`];
  return [...remoteHostProblems(where, entry), ...remoteDirProblems(where, entry, seenDirs, name)];
}

function accountProblems(name: string, raw: unknown, names: ReadonlySet<string>, seenDirs: Map<string, string>, options: AccountValidation): string[] {
  const where = `engines.claude.accounts.${name}`;
  const problems = ACCOUNT_NAME_RE.test(name) ? [] : [`${where}: an account name is letters, digits, ".", "_" and "-"`];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [...problems, `${where} must be a mapping with configDir`];
  const entry = raw as Record<string, unknown>;
  const isRemote = entry.remoteHost !== undefined || entry.remoteUser !== undefined;
  return [...problems, ...(isRemote ? remoteAccountProblems(where, entry, seenDirs, name) : localAccountProblems(where, { name, entry, names, seenDirs, options }))];
}

function localAccountProblems(where: string, account: { name: string; entry: Record<string, unknown>; names: ReadonlySet<string>; seenDirs: Map<string, string>; options: AccountValidation }): string[] {
  const { name, entry, names, seenDirs, options } = account;
  const problems = configDirProblems(where, entry.configDir, seenDirs, name, options.jinnHome);
  problems.push(...fallbackChainProblems(`${where}.fallback`, entry.fallback, { engines: ENGINE_NAMES, profiles: names, self: { engine: "claude", profile: name }, onDuplicate: options.onDuplicate }));
  const map = entry.fallbackModelMap;
  if (map !== undefined && (!map || typeof map !== "object" || Array.isArray(map))) {
    problems.push(`${where}.fallbackModelMap must be a mapping of model ids`);
  }
  return problems;
}

/**
 * Problems with `engines.claude.accounts` (empty = valid). Refused: a name that
 * cannot be written as `claude:<name>`, a `configDir` that fails the
 * employee-profile rules (absolute, outside the instance home, not the default
 * profile), two accounts on one canonical directory, and chains naming unknown
 * engines or accounts, or themselves. Cycles are tolerated, as for engines.
 * An account with `remoteHost` is judged as a path on that host instead: an
 * absolute POSIX path, unique per `user@host`, with no chain of its own.
 */
export function validateClaudeAccounts(engines: Record<string, unknown>, jinnHome?: string, onDuplicate?: DuplicateTolerance): string[] {
  const claude = engines.claude as { accounts?: unknown } | undefined;
  if (claude?.accounts === undefined) return [];
  if (!claude.accounts || typeof claude.accounts !== "object" || Array.isArray(claude.accounts)) {
    return ["engines.claude.accounts must be a mapping of account names"];
  }
  const accounts = claude.accounts as Record<string, unknown>;
  const names = new Set(Object.keys(accounts));
  const seenDirs = new Map<string, string>();
  return Object.entries(accounts).flatMap(([name, raw]) => accountProblems(name, raw, names, seenDirs, { jinnHome, onDuplicate }));
}
