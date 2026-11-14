/**
 * `engines.opencode.accounts`: several subscriptions to one opencode provider,
 * each staged as its own provider id (docs/design/opencode-accounts.md).
 *
 * This module is the shape and its load-time checks, plus the one normalised
 * view every reader uses. Checks that need opencode's model catalogue (is the
 * base known, does the provider id collide, is the key variable set) run later,
 * in chain problems and `hundredfold doctor`, because the catalogue is not known when
 * the config loads.
 */
import type { OpencodeAccountConfig } from "./config-types.js";
import { NAMES } from "./codename.js";
import { LEGACY_ENV_PREFIXES } from "./legacy/names.js";

export type { OpencodeAccountConfig } from "./config-types.js";

export const OPENCODE_ACCOUNT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const OPENCODE_PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
export const OPENCODE_KEY_ENV_RE = /^[A-Z_][A-Z0-9_]*$/;
/** Variables the gateway sets on every opencode process itself: a key variable of one of these names would overwrite them. */
const RESERVED_KEY_ENV: ReadonlySet<string> = new Set([
  "OPENCODE", "OPENCODE_API_KEY", "OPENCODE_PID", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT", "OPENCODE_PURE",
  // Common process variables: an account's key must never overwrite or stand in for one.
  "PATH", "HOME", "USER", "SHELL", "LANG", "TERM", "TMPDIR", "PWD", "NODE_OPTIONS", "NODE_PATH",
]);
/** Prefixes of the variables the gateway or opencode itself reads: the program's own (under its name and under the names it was called before), opencode's server and switch families (`OPENCODE_SERVER_*`, `OPENCODE_DISABLE_*`) and the loader, XDG and ssh families. */
const RESERVED_KEY_ENV_PREFIXES: readonly string[] = [
  `${NAMES.upper}_`,
  ...LEGACY_ENV_PREFIXES.map((prefix) => `${prefix}_`),
  "OPENCODE_SERVER_", "OPENCODE_DISABLE_", "LD_", "DYLD_", "XDG_", "SSH_",
];
/** The standard key variables of the common providers. Other tools, and opencode's own providers, read these; a key moved out of the gateway's environment for an account would be withheld from them. */
const PROVIDER_KEY_ENV: ReadonlySet<string> = new Set([
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY",
  "DEEPSEEK_API_KEY", "XAI_API_KEY", "MISTRAL_API_KEY", "GROQ_API_KEY",
]);
/** Fields that would put a secret in config.yaml. Refused, never staged. */
const INLINE_SECRET_FIELDS = ["apiKey", "key", "token"] as const;

/** One declared account, normalised. `base` absent = a built-in provider declared for a name, metering and a card. */
export interface OpencodeAccount {
  name: string;
  provider: string;
  base?: string;
  keyEnv?: string;
  label: string;
  models?: string[];
  monthlyUsd?: Record<string, number>;
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function monthlyUsdProblems(where: string, table: unknown): string[] {
  if (table === undefined) return [];
  if (!isMapping(table)) return [`${where}.usageLimits.monthlyUsd must be a mapping of model id to a monthly USD limit`];
  return Object.entries(table).flatMap(([model, value]) => [
    ...(typeof value !== "number" || !Number.isFinite(value) || value <= 0
      ? [`${where}.usageLimits.monthlyUsd["${model}"] must be a positive number (got ${JSON.stringify(value)})`] : []),
    ...(model !== "*" && model.includes("/")
      ? [`${where}.usageLimits.monthlyUsd["${model}"]: name the model without its provider (the account's provider is implied)`] : []),
  ]);
}

function providerProblems(where: string, name: string, provider: unknown, providers: Map<string, string>): string[] {
  if (typeof provider !== "string" || !OPENCODE_PROVIDER_ID_RE.test(provider)) {
    return [`${where}.provider must be an opencode provider id matching ${OPENCODE_PROVIDER_ID_RE.source}`];
  }
  if (provider === "opencode") return [`${where}.provider: "opencode" is opencode's own provider and cannot be an account's id`];
  const other = providers.get(provider);
  if (other !== undefined) return [`${where}.provider "${provider}" is already account "${other}"'s`];
  providers.set(provider, name);
  return [];
}

function isModelList(models: unknown): boolean {
  return Array.isArray(models) && models.length > 0 && models.every((m) => typeof m === "string" && m.length > 0 && !m.includes("/"));
}

function baseIdProblems(where: string, base: unknown, provider: unknown): string[] {
  if (typeof base !== "string" || !OPENCODE_PROVIDER_ID_RE.test(base)) return [`${where}.base must be an opencode provider id`];
  return base === provider ? [`${where}.base must differ from provider (leave base out to declare the built-in provider itself)`] : [];
}

/** An alias (with base) needs a key variable; a built-in provider takes neither a key variable nor a model subset. */
/** Why `keyEnv` cannot name an account's key variable, or undefined when it can. */
function reservedKeyEnvReason(keyEnv: string, references: ReadonlySet<string>): string | undefined {
  if (RESERVED_KEY_ENV.has(keyEnv) || RESERVED_KEY_ENV_PREFIXES.some((prefix) => keyEnv.startsWith(prefix))) return "is set by the gateway, opencode or the system for every process";
  if (PROVIDER_KEY_ENV.has(keyEnv)) return "is a provider's standard key variable, read by other tools";
  if (references.has(keyEnv)) return "is expanded elsewhere in config.yaml (${VAR})";
  return undefined;
}

function baseProblems(where: string, raw: Record<string, unknown>, references: ReadonlySet<string>): string[] {
  const { provider, base, keyEnv, models } = raw;
  if (base === undefined) {
    return [
      ...(keyEnv === undefined ? [] : [`${where}.keyEnv needs base: a built-in provider signs in the way opencode already does`]),
      ...(models === undefined ? [] : [`${where}.models needs base: a built-in provider serves its own catalogue`]),
    ];
  }
  const problems = baseIdProblems(where, base, provider);
  if (typeof keyEnv !== "string" || !OPENCODE_KEY_ENV_RE.test(keyEnv)) {
    problems.push(`${where}.keyEnv must name the environment variable holding the account's key (${OPENCODE_KEY_ENV_RE.source})`);
  } else {
    const reserved = reservedKeyEnvReason(keyEnv, references);
    if (reserved) problems.push(`${where}.keyEnv: ${keyEnv} ${reserved} and cannot hold an account's key: the gateway removes an account's key variable from every other process it starts, so it would be unset for them. Give the account its own variable`);
  }
  if (models !== undefined && !isModelList(models)) problems.push(`${where}.models must be a non-empty list of the base's model ids, without the provider`);
  return problems;
}

function accountProblems(name: string, raw: unknown, providers: Map<string, string>, references: ReadonlySet<string>): string[] {
  const where = `engines.opencode.accounts.${name}`;
  if (!OPENCODE_ACCOUNT_NAME_RE.test(name)) return [`${where}: an account name must match ${OPENCODE_ACCOUNT_NAME_RE.source}`];
  if (!isMapping(raw)) return [`${where} must be a mapping`];
  const inline = INLINE_SECRET_FIELDS.filter((field) => raw[field] !== undefined)
    .map((field) => `${where}.${field}: a key is never written in config; name the environment variable that holds it with keyEnv`);
  const label = raw.label === undefined || (typeof raw.label === "string" && raw.label.trim() !== "") ? [] : [`${where}.label must be a non-empty string`];
  const limits = raw.usageLimits === undefined ? []
    : isMapping(raw.usageLimits) ? monthlyUsdProblems(where, raw.usageLimits.monthlyUsd) : [`${where}.usageLimits must be a mapping`];
  return [...providerProblems(where, name, raw.provider, providers), ...inline, ...baseProblems(where, raw, references), ...label, ...limits];
}

/** Load-time problems with `engines.opencode.accounts` (empty = valid). `references` are the variables the rest of config.yaml expands from (`configEnvReferences`). */
export function validateOpencodeAccounts(engines: Record<string, unknown>, references: ReadonlySet<string> = new Set()): string[] {
  const opencode = engines.opencode;
  if (!isMapping(opencode) || opencode.accounts === undefined) return [];
  if (!isMapping(opencode.accounts)) return ["engines.opencode.accounts must be a mapping of account names"];
  const providers = new Map<string, string>();
  return Object.entries(opencode.accounts).flatMap(([name, raw]) => accountProblems(name, raw, providers, references));
}

function normalise(name: string, raw: OpencodeAccountConfig): OpencodeAccount {
  return {
    name,
    provider: raw.provider,
    ...(raw.base === undefined ? {} : { base: raw.base }),
    ...(raw.base === undefined || raw.keyEnv === undefined ? {} : { keyEnv: raw.keyEnv }),
    label: raw.label?.trim() || name,
    ...(raw.base !== undefined && raw.models !== undefined ? { models: [...raw.models] } : {}),
    ...(raw.usageLimits?.monthlyUsd === undefined ? {} : { monthlyUsd: { ...raw.usageLimits.monthlyUsd } }),
  };
}

/** Every declared account that passed the load-time checks, by name. A config that failed them never loads, so this only guards hand-built configs in tests. */
export function declaredOpencodeAccounts(config: { engines?: { opencode?: { accounts?: Record<string, OpencodeAccountConfig> } } }): OpencodeAccount[] {
  const accounts = config.engines?.opencode?.accounts;
  if (!isMapping(accounts)) return [];
  return Object.entries(accounts)
    .filter(([name, raw]) => accountProblems(name, raw, new Map(), new Set()).length === 0)
    .map(([name, raw]) => normalise(name, raw))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The declared account whose provider id is `provider`, if any. */
export function opencodeAccountByProvider(config: Parameters<typeof declaredOpencodeAccounts>[0], provider: string): OpencodeAccount | undefined {
  return declaredOpencodeAccounts(config).find((account) => account.provider === provider);
}

/** Accounts that stage a provider block of their own (those with a base). */
export function stagedOpencodeAccounts(config: Parameters<typeof declaredOpencodeAccounts>[0]): OpencodeAccount[] {
  return declaredOpencodeAccounts(config).filter((account) => account.base !== undefined);
}
