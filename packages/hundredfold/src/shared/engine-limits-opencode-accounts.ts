import type { Employee, EngineLimitBucket, EngineLimitEngineSnapshot, HundredfoldConfig } from "./types.js";
import { engineHealthForTarget, isEngineExhausted, readEngineHealth, type EngineHealth, type EngineHealthReading } from "./engine-health.js";
import { rosterEmployees, type EngineLimitAccountSnapshot } from "./engine-limits-accounts.js";
import { providerHealthKey } from "./engine-health-meter.js";
import { bindingHealthRecord } from "./engine-health-keys.js";
import { declaredOpencodeAccounts, type OpencodeAccount } from "./opencode-accounts-config.js";
import { opencodeAccountKeyEnvironment } from "./child-env.js";
import { opencodeCatalogue, opencodeClones, opencodeLocalApi } from "./opencode-catalogue.js";
import { oneAccountProblems } from "./opencode-accounts.js";

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
  /** What the standing hold on the provider (or one of its models) is: its class, when it was seen and why. Never the credential's identity. */
  lastFailure?: { class: "quota" | "auth" | "model-access"; at: string; reason?: string };
  problems?: string[];
}

export interface OpencodeAccountsDeps {
  /** The roster; default: the one the gateway registered at boot. */
  employees?: Iterable<Employee>;
  /** The gateway's environment, for `keySet`; default: the one the gateway holds its account keys in (child-env.ts). */
  env?: Record<string, string | undefined>;
  health?: EngineHealthReading;
  now?: Date;
}

function providerOf(model: string | undefined | null): string | undefined {
  const slash = model === undefined || model === null ? -1 : model.indexOf("/");
  return model !== undefined && model !== null && slash > 0 ? model.slice(0, slash) : undefined;
}

/** Employees whose own model is on `provider`: an unpinned one runs on the engine's configured model. */
function employeesOn(provider: string, config: HundredfoldConfig, employees: readonly Employee[]): string[] {
  const names: string[] = [];
  for (const employee of employees) {
    if ((employee.engine ?? config.engines.default) !== "opencode") continue;
    if (providerOf(employee.model ?? config.engines.opencode?.model) === provider) names.push(employee.name);
  }
  return names.sort((a, b) => a.localeCompare(b));
}

/**
 * What is wrong with an account, in `hundredfold doctor`'s words (opencodeAccountProblems): a base missing from the
 * catalogue, a provider id that collides with one in it, an unknown subset model, a base whose endpoints are not
 * staged yet, a model a 1.x local binary leaves out, a key variable the gateway lacks. The checks that need the
 * catalogue wait for it (a gateway whose discovery has not landed blames no account for that).
 */
function problemsOf(account: OpencodeAccount, env: Record<string, string | undefined>): string[] {
  return oneAccountProblems(account, {
    catalogue: opencodeCatalogue(),
    clones: opencodeClones(),
    env,
    ...(opencodeLocalApi() ? { localApi: opencodeLocalApi()! } : {}),
  });
}

/** The record holding the provider out right now: of its own key's and the engine-wide one's, the one that binds (the later reopening), so `until` and `nextTryAt` say when the account is next tried. */
function holdingRecord(health: EngineHealthReading, provider: string, now: Date): EngineHealth | undefined {
  const holding = [providerHealthKey(provider), "opencode"].filter((key) => isEngineExhausted(health, key, now)).map((key) => health[key]!);
  return bindingHealthRecord(holding);
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

/** A classed hold in force under `key`, with when it was seen. */
function classedHold(resolved: Resolved, key: string): { record: EngineHealth; at: string } | undefined {
  const record = resolved.health[key];
  if (record?.failureClass === undefined || record.observedAt === undefined) return undefined;
  return isEngineExhausted(resolved.health, key, resolved.now) ? { record, at: record.observedAt } : undefined;
}

/** The newest classed hold in force on the provider's own key or on one of its models' keys (`opencode/<provider>/<model>`). */
function lastFailureOf(account: OpencodeAccount, resolved: Resolved): OpencodeAccountLimitSnapshot["lastFailure"] {
  const own = providerHealthKey(account.provider);
  const holds = Object.keys(resolved.health)
    .filter((key) => key === own || key.startsWith(`${own}/`))
    .flatMap((key) => classedHold(resolved, key) ?? []);
  const atMs = (hold: { at: string }): number => { const ms = Date.parse(hold.at); return Number.isFinite(ms) ? ms : 0; };
  const newest = holds.sort((a, b) => atMs(b) - atMs(a))[0];
  if (newest === undefined) return undefined;
  const { failureClass, reason } = newest.record;
  return { class: failureClass!, at: newest.at, ...(reason ? { reason } : {}) };
}

/** The account's own declaration: its base, and its key variable's name with whether it is set. */
function declarationFields(account: OpencodeAccount, env: Resolved["env"]): Pick<OpencodeAccountLimitSnapshot, "base" | "keyEnv" | "keySet"> {
  return {
    ...(account.base === undefined ? {} : { base: account.base }),
    ...(account.keyEnv === undefined ? {} : { keyEnv: account.keyEnv, keySet: Boolean(env[account.keyEnv]) }),
  };
}

function snapshotOf(account: OpencodeAccount, config: HundredfoldConfig, engine: EngineLimitEngineSnapshot, resolved: Resolved): OpencodeAccountLimitSnapshot {
  const prefix = `${account.provider}/`;
  const buckets = (engine.buckets ?? []).filter((bucket) => bucket.id.startsWith(prefix));
  const problems = problemsOf(account, resolved.env);
  const failure = lastFailureOf(account, resolved);
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
    ...(failure ? { lastFailure: failure } : {}),
    ...(problems.length > 0 ? { problems } : {}),
  };
}

/** Every declared account's snapshot, from the engine snapshot just read; undefined when none is declared. */
export function collectOpencodeAccounts(
  config: HundredfoldConfig,
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
    // The card is the gateway's own: a hold another machine's turn recorded is not one its sessions see.
    health: engineHealthForTarget(deps.health ?? readEngineHealth(now), undefined),
    now,
  };
  return accounts.map((account) => snapshotOf(account, config, engine, resolved));
}
