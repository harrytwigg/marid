import { opencodeCatalogue, opencodeClones } from "../shared/opencode-catalogue.js";
import { declaredOpencodeAccounts } from "../shared/opencode-accounts-config.js";
import { opencodeAccountProblems, opencodeChainContext, opencodeChainProblems } from "../shared/opencode-accounts.js";
import type { FallbackChainEntry } from "../shared/fallback-chain-wire.js";
import type { JinnConfig } from "../shared/types.js";
import type { DoctorFinding } from "./doctor.js";

/**
 * `doctor`'s report on opencode accounts (docs/design/opencode-accounts.md):
 * the problems with each declared account that need opencode's catalogue or the
 * gateway's environment, and every fallback-chain link that names a model or an
 * account opencode does not serve. Read-only; it asks opencode for its catalogue
 * the way `jinn limits` does, and never prints a key (only the variable's name).
 */

export interface OpencodeAccountsReading {
  accounts: number;
  /** Problems with the declared accounts themselves. */
  accountProblems: string[];
  /** Problems with the chain links that name opencode models. */
  chainProblems: string[];
}

type WrittenChain = { where: string; chain: FallbackChainEntry[] };
type ChainSection = { fallback?: FallbackChainEntry[]; accounts?: Record<string, { fallback?: FallbackChainEntry[] }> } | undefined;

/** A Claude section's accounts' chains. */
function accountChains(section: ChainSection): WrittenChain[] {
  return Object.entries(section?.accounts ?? {}).flatMap(([account, entry]) =>
    Array.isArray(entry?.fallback) ? [{ where: `engines.claude.accounts.${account}.fallback`, chain: entry.fallback }] : []);
}

/** The chains a config writes: each engine's, each Claude account's and each employee's, by where they are written. */
function writtenChains(config: JinnConfig, employees: ReadonlyArray<{ name: string; fallback?: FallbackChainEntry[] }>): WrittenChain[] {
  const engines = Object.entries(config.engines as unknown as Record<string, ChainSection>);
  return [
    ...engines.flatMap(([name, section]) => (Array.isArray(section?.fallback) ? [{ where: `engines.${name}.fallback`, chain: section.fallback }] : [])),
    ...accountChains((config.engines as unknown as Record<string, ChainSection>).claude),
    ...employees.flatMap((employee) => (Array.isArray(employee.fallback) ? [{ where: `employees.${employee.name}.fallback`, chain: employee.fallback }] : [])),
  ];
}

/** Whether a chain names an opencode model at all, so reading the catalogue is worth it. */
function namesOpencodeModel(chain: FallbackChainEntry[]): boolean {
  return chain.some((entry) => typeof entry === "object" && entry !== null && entry.engine === "opencode" && typeof entry.model === "string");
}

/**
 * Read opencode's catalogue and check the declared accounts and the opencode
 * links in chains. Nothing when the instance declares no account and no chain
 * names an opencode model, or opencode is not installed.
 */
export async function collectOpencodeAccounts(config: JinnConfig): Promise<OpencodeAccountsReading | undefined> {
  const accounts = declaredOpencodeAccounts(config);
  let employees: Array<{ name: string; fallback?: FallbackChainEntry[] }> = [];
  try {
    const { orgRegistry } = await import("../gateway/org-registry.js");
    employees = [...orgRegistry(config).values()];
  } catch {
    /* an unreadable org has no chains to check here */
  }
  const chains = writtenChains(config, employees);
  if (accounts.length === 0 && !chains.some(({ chain }) => namesOpencodeModel(chain))) return undefined;

  const [{ engineAvailable, refreshOpencodeModels }, { opencodeDiscoveryEnv }] = await Promise.all([import("../shared/models.js"), import("../engines/opencode-launch.js")]);
  if (!engineAvailable(config, "opencode")) return undefined;
  // Discovery logs to stdout, which would break `jinn doctor --json`: this process only reports.
  const { configureLogger } = await import("../shared/logger.js");
  configureLogger({ stdout: false, file: false });
  await refreshOpencodeModels(config, { env: opencodeDiscoveryEnv(config) });
  const catalogue = opencodeCatalogue();

  const { resolveBin } = await import("../shared/resolve-bin.js");
  const { localOpencodeVersion } = await import("../shared/opencode-bin-version.js");
  const { opencodeApiOf } = await import("../engines/opencode-version.js");
  const api = opencodeApiOf(await localOpencodeVersion(resolveBin("opencode", config.engines.opencode?.bin)));

  const env = process.env;
  const context = opencodeChainContext(config, catalogue, env, opencodeClones());
  return {
    accounts: accounts.length,
    accountProblems: opencodeAccountProblems(config, { catalogue, clones: opencodeClones(), env, localApi: api }),
    chainProblems: chains.flatMap(({ where, chain }) => opencodeChainProblems(where, chain, context)),
  };
}

/** The doctor findings: ok, or one problem per account and chain problem. */
export function opencodeAccountsFindings(reading: OpencodeAccountsReading): DoctorFinding[] {
  const problems = [...reading.accountProblems, ...reading.chainProblems];
  if (problems.length > 0) return problems.map((message) => ({ level: "problem" as const, message }));
  return [{ level: "ok", message: reading.accounts > 0 ? `opencode: ${reading.accounts} declared account(s) and the chains that name opencode models have no problem.` : "opencode: the chains that name opencode models have no problem." }];
}
