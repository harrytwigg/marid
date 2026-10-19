import path from "node:path";
import { canonicalClaudeConfigDir, claudeProfileFromDir, validateEmployeeClaudeConfigDir, type ClaudeProfile } from "./claude-profile.js";
import { claudeAccountKey, DEFAULT_CLAUDE_ACCOUNT } from "./engine-account.js";
import { ENGINE_NAMES } from "./models.js";
import type { DuplicateTolerance } from "./fallback-chain-load.js";
import { fallbackChainProblems, type FallbackChainEntry } from "./fallback-chain-wire.js";

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
 */
export interface ClaudeAccountConfig {
  configDir: string;
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

/** The `accounts` mapping under `engines.claude`, read loosely: config arrives
 *  as parsed YAML, and validation is what refuses a bad shape. */
function accountsSection(engines: unknown): Record<string, unknown> {
  const claude = (engines as { claude?: unknown } | undefined)?.claude;
  const accounts = (claude as { accounts?: unknown } | undefined)?.accounts;
  return accounts && typeof accounts === "object" && !Array.isArray(accounts) ? accounts as Record<string, unknown> : {};
}

/** The names under `engines.claude.accounts`, valid or not: what a chain's `profile` is checked against. */
export function accountNames(engines: unknown): Set<string> {
  return new Set(Object.keys(accountsSection(engines)));
}

/** Every declared account whose `configDir` is usable, in declaration order. */
export function declaredClaudeAccounts(config: { engines: unknown }): DeclaredClaudeAccount[] {
  const out: DeclaredClaudeAccount[] = [];
  for (const [name, raw] of Object.entries(accountsSection(config.engines))) {
    const entry = raw as Partial<ClaudeAccountConfig> | null;
    if (!entry || typeof entry.configDir !== "string" || !path.posix.isAbsolute(entry.configDir.trim())) continue;
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

function accountProblems(name: string, raw: unknown, names: ReadonlySet<string>, seenDirs: Map<string, string>, options: AccountValidation): string[] {
  const where = `engines.claude.accounts.${name}`;
  const problems = ACCOUNT_NAME_RE.test(name) ? [] : [`${where}: an account name is letters, digits, ".", "_" and "-"`];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [...problems, `${where} must be a mapping with configDir`];
  const entry = raw as Record<string, unknown>;
  problems.push(...configDirProblems(where, entry.configDir, seenDirs, name, options.jinnHome));
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
