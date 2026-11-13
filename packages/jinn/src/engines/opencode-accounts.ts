import crypto from "node:crypto";
import type { JinnConfig } from "../shared/types.js";
import { opencodeClones } from "../shared/opencode-catalogue.js";
import { stagedOpencodeAccounts } from "../shared/opencode-accounts-config.js";
import { accountCloneModels, planAccountProvider, unservedModelError, type OpencodeProviderBlock } from "../shared/opencode-accounts.js";
import type { OpencodeApi } from "./opencode-version.js";
import { opencodeAccountKeyEnvironment } from "../shared/child-env.js";

/**
 * The accounts of `engines.opencode.accounts` as an opencode process is given
 * them (docs/design/opencode-accounts.md, "Staging"): one `provider` block per
 * account that has a base, in the shape of the process's own CLI generation,
 * plus the environment variables that hold their keys.
 *
 * The key is only ever a value in `env`: the blocks carry `{env:<keyEnv>}`, the
 * local child's environment and a remote host's 0600 account-keys file carry the
 * value, and the fingerprint carries a short hash of it. Nothing here reaches a
 * log line, a command line or a staged config.
 */

/** One resolved view of the declared accounts, taken when a process is started. */
export interface OpencodeAccountStaging {
  /** `provider` blocks by provider id, for a process whose CLI speaks `api`. */
  providers(api: OpencodeApi): Record<string, OpencodeProviderBlock>;
  /** The error for a turn on `model` (`<provider>/<model>`) that a process of this CLI generation cannot serve (an account's model off its main endpoint, on 1.x), or undefined when it can. */
  unservedModel(model: string, api: OpencodeApi): string | undefined;
  /** `<keyEnv>` → key, for each account whose variable is set in the gateway's environment. Set on a local child explicitly (the gateway scrubs what it passes down), and carried to a remote host through its 0600 account-keys file. */
  readonly env: Readonly<Record<string, string>>;
  /** What makes a warm server stale: each account's provider id, model list and a short hash of its key. Never the key. */
  readonly fingerprint: string;
  /** Every declared account's key variable, reachable or not: taken out of the environment a process inherits, so it holds only the keys in {@link env}. */
  readonly scrub: readonly string[];
}

/** Who is asking for accounts: the session a process is for and the model the turn runs on. */
export interface OpencodeAccountScope {
  sessionId?: string;
  model?: string;
}

/** Reads the accounts one session may use; a closure over the live config, as the engine's other settings are. */
export type OpencodeAccountsReader = (scope: OpencodeAccountScope) => OpencodeAccountStaging | undefined;

/** A short, one-way tag of a key: enough to tell a rotated key from the old one, not enough to use. */
export function shortKeyHash(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 12);
}

/**
 * The accounts that stage a provider block, resolved against the catalogue
 * clones discovery kept and `environment` (the gateway's own), or undefined
 * when no account has a base. `reach` (provider ids) narrows them to the ones
 * a session may use: its blocks and keys are only those, and none reachable
 * stages no block and no key (but still lists every key variable to scrub). An account with no key set still stages its block:
 * its turns fail as auth and the chain moves on (doctor names the variable).
 */
export function opencodeAccountStaging(
  config: JinnConfig,
  environment: Readonly<Record<string, string | undefined>> = opencodeAccountKeyEnvironment(),
  reach?: ReadonlySet<string>,
): OpencodeAccountStaging | undefined {
  const declared = stagedOpencodeAccounts(config);
  if (declared.length === 0) return undefined;
  const accounts = declared.filter((account) => reach === undefined || reach.has(account.provider));
  const clones = opencodeClones();
  const resolved = accounts.map((account) => ({ account, models: accountCloneModels(account, clones), key: environment[account.keyEnv!]?.trim() || undefined }));
  const env: Record<string, string> = {};
  for (const { account, key } of resolved) if (key !== undefined) env[account.keyEnv!] = key;
  const fingerprint = JSON.stringify(resolved.map(({ account, models, key }) => ({
    provider: account.provider,
    models: models.map((m) => m.id),
    key: key === undefined ? null : shortKeyHash(key),
  })));
  return {
    providers(api) {
      return Object.fromEntries(resolved.map(({ account, models }) => [account.provider, planAccountProvider(account, models, api).block]));
    },
    unservedModel(model, api) {
      for (const { account, models } of resolved) {
        if (planAccountProvider(account, models, api).dropped.some((id) => `${account.provider}/${id}` === model)) return unservedModelError(model, account.name);
      }
      return undefined;
    },
    env,
    fingerprint,
    scrub: declared.map((account) => account.keyEnv!),
  };
}
