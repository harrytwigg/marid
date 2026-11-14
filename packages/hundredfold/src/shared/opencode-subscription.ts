import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import type { HundredfoldConfig } from "./config-types.js";
import { opencodeAccountKeyEnvironment } from "./child-env.js";
import { opencodeAccountByProvider, stagedOpencodeAccounts, type OpencodeAccount } from "./opencode-accounts-config.js";

/**
 * Which opencode providers are subscriptions, how long a spent one is held out,
 * and what the stored credential of one looks like to a change detector.
 *
 * Kept in one small module so that a provider's membership, its re-probe
 * interval and its credential identity are each decided in one place. The
 * failure classifier and the health writers ask here and never compare provider
 * names themselves.
 */

type OpencodeConfig = Pick<HundredfoldConfig, "engines">;

/** The providers sold as a subscription unless the config says otherwise. */
export const DEFAULT_SUBSCRIPTION_PROVIDERS: readonly string[] = ["opencode-go"];

/** How long a spent subscription provider is held out when it stated no reset. */
export const DEFAULT_REPROBE_MINUTES = 60;

/** How long an `auth` failure with no readable credential identity is held: long
 *  enough to spare every turn a failed request, short enough that a wrong
 *  verdict cannot lock a provider out for good. */
export const UNFINGERPRINTED_AUTH_HOLD_MS = 24 * 60 * 60_000;

function opencodeSettings(config: OpencodeConfig | undefined): NonNullable<NonNullable<HundredfoldConfig["engines"]>["opencode"]> | undefined {
  return config?.engines?.opencode;
}

/** The staged accounts of the config last loaded: a reader that has no config in hand (the health store judging an `auth` record) finds an alias account's key variable here. */
let loadedAccounts: readonly OpencodeAccount[] = [];

/** Remember the declared accounts of a freshly loaded config. */
export function rememberOpencodeAccounts(config: Parameters<typeof stagedOpencodeAccounts>[0]): void {
  loadedAccounts = stagedOpencodeAccounts(config);
}

/** Test seam. */
export function forgetOpencodeAccountsForTest(): void {
  loadedAccounts = [];
}

/** The account that is `provider`: the config's when one is given, else the last loaded config's. */
function accountOf(provider: string, config: OpencodeConfig | undefined): Pick<OpencodeAccount, "base" | "keyEnv"> | undefined {
  return (config ? opencodeAccountByProvider(config, provider) : undefined) ?? loadedAccounts.find((account) => account.provider === provider);
}

function listedSubscription(provider: string, config: OpencodeConfig | undefined): boolean {
  const configured = opencodeSettings(config)?.subscriptionProviders;
  return (Array.isArray(configured) ? configured : DEFAULT_SUBSCRIPTION_PROVIDERS).includes(provider);
}

/**
 * Whether `provider` is a subscription: a 402 on it is a spent allowance that reopens, not a balance nobody will top up.
 * A declared account counts when its `base` is one (an alias of a subscription); a built-in account is the provider
 * itself, so the list answers for it.
 */
export function isOpencodeSubscriptionProvider(provider: string | undefined, config: OpencodeConfig | undefined): boolean {
  if (provider === undefined || provider === "") return false;
  if (listedSubscription(provider, config)) return true;
  const base = accountOf(provider, config)?.base;
  return base !== undefined && listedSubscription(base, config);
}

/** How long a spent `provider` is held out before it is offered a turn again, in ms. */
export function opencodeReprobeMs(_provider: string | undefined, config: OpencodeConfig | undefined): number {
  const minutes = opencodeSettings(config)?.reprobeMinutes;
  return (typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_REPROBE_MINUTES) * 60_000;
}

/** The provider of an opencode health key (`opencode/<provider>` or `opencode/<provider>/<model>`), else undefined. */
export function providerOfOpencodeHealthKey(key: string): string | undefined {
  if (!key.startsWith("opencode/")) return undefined;
  const provider = key.slice("opencode/".length).split("/")[0];
  return provider ? provider : undefined;
}

/** The health key of one opencode model, `opencode/<provider>/<model>`, from the model as a link spells it (`provider/model`). */
export function opencodeModelHealthKey(model: string | undefined): string | undefined {
  const slash = model === undefined ? -1 : model.indexOf("/");
  return model !== undefined && slash > 0 && slash < model.length - 1 ? `opencode/${model}` : undefined;
}

function opencodeDatabasePath(env: NodeJS.ProcessEnv): string {
  const data = env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), ".local", "share");
  return path.join(data, "opencode", "opencode.db");
}

/** The non-secret identity of the credential rows stored for `provider` in opencode 2.x's database: row id, last update and active flag. Never the secret column. */
function storedCredentialIdentity(provider: string, env: NodeJS.ProcessEnv): string | undefined {
  const file = opencodeDatabasePath(env);
  if (!fs.existsSync(file)) return undefined;
  let db: Database.Database | undefined;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true, timeout: 500 });
    const rows = db
      .prepare("SELECT id, active, time_updated FROM credential WHERE integration_id = ? ORDER BY id")
      .all(provider) as { id: string; active: number | null; time_updated: number }[];
    if (rows.length === 0) return undefined;
    return rows.map((row) => `${row.id}:${row.active ?? ""}:${row.time_updated}`).join("|");
  } catch {
    return undefined;
  } finally {
    try { db?.close(); } catch { /* best effort */ }
  }
}

/**
 * Whether the credential `provider` signs in with is no longer the one `stored` was written against. An alias
 * account's identity is its key, which only a process that holds the key variable can read (the gateway; not the
 * operator's shell running `hundredfold limits` or `hundredfold doctor`). A reader that cannot read it cannot say the key changed,
 * so the hold stands there; every other provider reads opencode's stored credential, which any process reaches, and
 * an unreadable one reads as changed.
 */
export function opencodeCredentialChanged(provider: string | undefined, stored: string): boolean {
  const current = opencodeCredentialFingerprint(provider, undefined);
  if (current === undefined && provider !== undefined && accountOf(provider, undefined)?.base !== undefined) return false;
  return current !== stored;
}

export interface FingerprintContext {
  /** The turn ran on another machine: its credential lives there and cannot be read from here. */
  remote?: boolean;
}

/** An alias account signs in with the key its variable holds, so its identity is a short sha256 of that key (as the gateway holds it, child-env.ts). undefined with no key set. */
function aliasKeyFingerprint(keyEnv: string | undefined): string | undefined {
  const key = keyEnv === undefined ? undefined : opencodeAccountKeyEnvironment()[keyEnv]?.trim();
  return key ? createHash("sha256").update(key).digest("hex").slice(0, 32) : undefined;
}

/**
 * An opaque identity of the credential `provider` signs in with, for noticing that
 * it changed. Never the key itself. undefined when nothing can be read, a remote
 * host's credential among them, which leaves the record on its time limit.
 *
 * opencode 2.x keeps credentials in its database (`credential` table), and 1.x's
 * `auth.json` is left behind unchanged, so only the database is read.
 */
export function opencodeCredentialFingerprint(
  provider: string | undefined,
  config: OpencodeConfig | undefined,
  context: FingerprintContext = {},
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (provider === undefined || provider === "" || context.remote) return undefined;
  const account = accountOf(provider, config);
  if (account?.base !== undefined) return aliasKeyFingerprint(account.keyEnv);
  const identity = storedCredentialIdentity(provider, env);
  return identity === undefined ? undefined : createHash("sha256").update(`opencode-credential\0${provider}\0${identity}`).digest("hex").slice(0, 32);
}
