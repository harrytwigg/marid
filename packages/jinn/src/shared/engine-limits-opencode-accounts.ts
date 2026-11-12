import type { Employee, EngineLimitBucket, EngineLimitEngineSnapshot, JinnConfig } from "./types.js";
import { isEngineExhausted, readEngineHealth, type EngineHealth, type EngineHealthReading } from "./engine-health.js";
import { rosterEmployees, type EngineLimitAccountSnapshot } from "./engine-limits-accounts.js";
import { providerHealthKey } from "./engine-health-meter.js";
import { declaredOpencodeAccounts, type OpencodeAccount } from "./opencode-accounts-config.js";
import { opencodeAccountKeyEnvironment } from "./child-env.js";

/**
 * `accounts.opencode` on the limits response: one entry per declared opencode
 * account, built-in providers included (docs/design/opencode-accounts.md, "API").
 *
 * The windows are the engine snapshot's own buckets, filtered to the account's
 * provider: the meter already priced every model against the allowance that
 * governs it, accounts included. Health is read, never written, here.
 */

/** One declared opencode account as the limits response carries it. */
export interface OpencodeAccountLimitSnapshot extends EngineLimitAccountSnapshot {
  provider: string;
  base?: string;
  /** The variable's name; never its value. */
  keyEnv?: string;
  /** With `base`: whether `keyEnv` is set in the gateway's environment. */
  keySet?: boolean;
  /** One per metered model: id `<provider>/<model>`, windows 5h/7d/30d. */
  buckets: EngineLimitBucket[];
  /** When health stops holding the provider: `recheckAt`, else `until`. */
  nextTryAt?: string;
  problems?: string[];
}

export interface OpencodeAccountsDeps {
  /** The roster; default: the one the gateway registered at boot. */
  employees?: Iterable<Employee>;
  /** The gateway's environment, for `keySet`; default: `process.env`. */
  env?: Record<string, string | undefined>;
  health?: EngineHealthReading;
  now?: Date;
}

function providerOf(model: string | undefined | null): string | undefined {
  const slash = model === undefined || model === null ? -1 : model.indexOf("/");
  return model !== undefined && model !== null && slash > 0 ? model.slice(0, slash) : undefined;
}

/** Employees whose own model is on `provider`: an unpinned one runs on the engine's configured model. */
function employeesOn(provider: string, config: JinnConfig, employees: readonly Employee[]): string[] {
  const names: string[] = [];
  for (const employee of employees) {
    if ((employee.engine ?? config.engines.default) !== "opencode") continue;
    if (providerOf(employee.model ?? config.engines.opencode?.model) === provider) names.push(employee.name);
  }
  return names.sort((a, b) => a.localeCompare(b));
}

/**
 * What this layer can tell is wrong with an account: a key variable the gateway's environment lacks. The checks
 * that need opencode's catalogue (base missing, an unknown subset model, a provider collision) belong to chain
 * problems and `jinn doctor`, which know whether the catalogue was discovered at all: the registry this layer
 * sees may only hold the configured default.
 */
function problemsOf(account: OpencodeAccount, env: Record<string, string | undefined>): string[] {
  return account.base !== undefined && account.keyEnv !== undefined && !env[account.keyEnv]
    ? [`${account.keyEnv} is not set in the gateway's environment`] : [];
}

/** The record holding the provider out right now: its own key first, then the engine-wide one. */
function holdingRecord(health: EngineHealthReading, provider: string, now: Date): EngineHealth | undefined {
  for (const key of [providerHealthKey(provider), "opencode"]) {
    if (isEngineExhausted(health, key, now)) return health[key];
  }
  return undefined;
}

interface Resolved {
  employees: readonly Employee[];
  env: Record<string, string | undefined>;
  health: EngineHealthReading;
  now: Date;
}

/** What health says about the account's provider: held out until when, and when it is next tried. */
function holdFields(account: OpencodeAccount, resolved: Resolved): Pick<OpencodeAccountLimitSnapshot, "exhausted" | "nextTryAt"> {
  const holding = holdingRecord(resolved.health, account.provider, resolved.now);
  if (!holding) return {};
  const nextTryAt = holding.recheckAt ?? holding.until;
  return { exhausted: holding.until ? { until: holding.until } : {}, ...(nextTryAt ? { nextTryAt } : {}) };
}

/** The account's own declaration: its base, and its key variable's name with whether it is set. */
function declarationFields(account: OpencodeAccount, env: Resolved["env"]): Pick<OpencodeAccountLimitSnapshot, "base" | "keyEnv" | "keySet"> {
  return {
    ...(account.base === undefined ? {} : { base: account.base }),
    ...(account.keyEnv === undefined ? {} : { keyEnv: account.keyEnv, keySet: Boolean(env[account.keyEnv]) }),
  };
}

function snapshotOf(account: OpencodeAccount, config: JinnConfig, engine: EngineLimitEngineSnapshot, resolved: Resolved): OpencodeAccountLimitSnapshot {
  const prefix = `${account.provider}/`;
  const buckets = (engine.buckets ?? []).filter((bucket) => bucket.id.startsWith(prefix));
  const problems = problemsOf(account, resolved.env);
  return {
    name: engine.name,
    available: engine.available,
    status: engine.available ? (buckets.length > 0 ? "snapshot" : "unsupported") : "unavailable",
    source: engine.source,
    refreshedAt: engine.refreshedAt,
    models: engine.models.filter((model) => model.id.startsWith(prefix)),
    account: account.name,
    label: account.label,
    location: { kind: "local" },
    employees: employeesOn(account.provider, config, resolved.employees),
    provider: account.provider,
    ...declarationFields(account, resolved.env),
    buckets,
    ...holdFields(account, resolved),
    ...(problems.length > 0 ? { problems } : {}),
  };
}

/** Every declared account's snapshot, from the engine snapshot just read; undefined when none is declared. */
export function collectOpencodeAccounts(
  config: JinnConfig,
  engine: EngineLimitEngineSnapshot,
  deps: OpencodeAccountsDeps = {},
): OpencodeAccountLimitSnapshot[] | undefined {
  const accounts = declaredOpencodeAccounts(config);
  if (accounts.length === 0) return undefined;
  const now = deps.now ?? new Date();
  const resolved: Resolved = {
    // Read once per account below, so an iterator (the roster is a Map's values) is made a list first.
    employees: [...(deps.employees ?? rosterEmployees())],
    env: deps.env ?? opencodeAccountKeyEnvironment(),
    health: deps.health ?? readEngineHealth(now),
    now,
  };
  return accounts.map((account) => snapshotOf(account, config, engine, resolved));
}
