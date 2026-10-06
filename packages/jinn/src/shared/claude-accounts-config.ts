import path from "node:path";
import { canonicalClaudeConfigDir, claudeProfileFromDir, validateEmployeeClaudeConfigDir, type ClaudeProfile } from "./claude-profile.js";
import { claudeAccountKey, DEFAULT_CLAUDE_ACCOUNT } from "./engine-account.js";
import { ENGINE_NAMES, isKnownEngine } from "./models.js";

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
  /** Engine names, `claude` for the default account, or `claude:<name>`. */
  fallback?: string[];
  fallbackModelMap?: Record<string, string>;
}

export interface DeclaredClaudeAccount {
  name: string;
  key: string;
  profile: Exclude<ClaudeProfile, null>;
  fallback: string[] | undefined;
  fallbackModelMap: Record<string, string> | undefined;
}

/** The `accounts` mapping under `engines.claude`, read loosely: config arrives
 *  as parsed YAML, and validation is what refuses a bad shape. */
function accountsSection(engines: unknown): Record<string, unknown> {
  const claude = (engines as { claude?: unknown } | undefined)?.claude;
  const accounts = (claude as { accounts?: unknown } | undefined)?.accounts;
  return accounts && typeof accounts === "object" && !Array.isArray(accounts) ? accounts as Record<string, unknown> : {};
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
      fallback: Array.isArray(entry.fallback) ? entry.fallback.filter((e): e is string => typeof e === "string") : undefined,
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

function chainProblems(where: string, chain: unknown, names: ReadonlySet<string>, self: string): string[] {
  if (chain === undefined) return [];
  if (!Array.isArray(chain)) return [`${where} must be a list of engines or accounts (got ${typeof chain})`];
  const problems: string[] = [];
  chain.forEach((entry, index) => {
    if (typeof entry !== "string") {
      problems.push(`${where}[${index}] must be a string (got ${typeof entry})`);
    } else if (entry === self) {
      problems.push(`${where} must not name ${self} itself`);
    } else if (entry.startsWith(`${DEFAULT_CLAUDE_ACCOUNT}:`)) {
      if (!names.has(entry.slice(DEFAULT_CLAUDE_ACCOUNT.length + 1))) {
        problems.push(`${where}[${index}] "${entry}" names no account under engines.claude.accounts`);
      }
    } else if (!isKnownEngine(entry)) {
      problems.push(`${where}[${index}] "${entry}" is not a known engine (${ENGINE_NAMES.join(", ")}) or a declared account (claude:<name>)`);
    }
  });
  return problems;
}

/**
 * Problems with `engines.claude.accounts` (empty = valid). Refused: a name that
 * cannot be written as `claude:<name>`, a `configDir` that fails the
 * employee-profile rules (absolute, outside the instance home, not the default
 * profile), two accounts on one canonical directory, and chains naming unknown
 * engines or accounts, or themselves. Cycles are tolerated, as for engines.
 */
export function validateClaudeAccounts(engines: Record<string, unknown>, jinnHome?: string): string[] {
  const claude = engines.claude as { accounts?: unknown } | undefined;
  if (claude?.accounts === undefined) return [];
  if (!claude.accounts || typeof claude.accounts !== "object" || Array.isArray(claude.accounts)) {
    return ["engines.claude.accounts must be a mapping of account names"];
  }
  const accounts = claude.accounts as Record<string, unknown>;
  const names = new Set(Object.keys(accounts));
  const problems: string[] = [];
  const seenDirs = new Map<string, string>();
  for (const [name, raw] of Object.entries(accounts)) {
    const where = `engines.claude.accounts.${name}`;
    if (!ACCOUNT_NAME_RE.test(name)) problems.push(`${where}: an account name is letters, digits, ".", "_" and "-"`);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      problems.push(`${where} must be a mapping with configDir`);
      continue;
    }
    const entry = raw as Record<string, unknown>;
    if (typeof entry.configDir !== "string") {
      problems.push(`${where}.configDir must be an absolute path`);
    } else {
      const why = validateEmployeeClaudeConfigDir({ claudeConfigDir: entry.configDir }, jinnHome);
      if (why) problems.push(`${where}: ${why.replace(/^claudeConfigDir/, "configDir")}`);
      const dir = canonicalClaudeConfigDir(entry.configDir);
      const other = seenDirs.get(dir);
      if (other) problems.push(`${where}.configDir ${dir} is already account ${other}'s`);
      else seenDirs.set(dir, name);
    }
    problems.push(...chainProblems(`${where}.fallback`, entry.fallback, names, `claude:${name}`));
    const map = entry.fallbackModelMap;
    if (map !== undefined && (!map || typeof map !== "object" || Array.isArray(map))) {
      problems.push(`${where}.fallbackModelMap must be a mapping of model ids`);
    }
  }
  return problems;
}

/** Problems with account entries in the default account's own chain,
 *  `engines.claude.fallback`, which the engine validator would read as typos. */
export function claudeChainAccountProblems(engines: Record<string, unknown>): string[] {
  const claude = engines.claude as { fallback?: unknown; accounts?: unknown } | undefined;
  const chain = claude?.fallback;
  if (!Array.isArray(chain)) return [];
  const names = new Set(Object.keys(accountsSection(engines)));
  return chain.flatMap((entry, index) => typeof entry === "string" && entry.startsWith(`${DEFAULT_CLAUDE_ACCOUNT}:`)
    && !names.has(entry.slice(DEFAULT_CLAUDE_ACCOUNT.length + 1))
    ? [`engines.claude.fallback[${index}] "${entry}" names no account under engines.claude.accounts`]
    : []);
}
