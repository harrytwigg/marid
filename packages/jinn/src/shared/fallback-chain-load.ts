import { accountNames } from "./claude-accounts-config.js";
import { logger } from "./logger.js";
import { fallbackChainProblems, type FallbackChainDuplicate } from "./fallback-chain-wire.js";
import { ENGINE_NAMES } from "./models.js";

/**
 * Duplicate chain entries are refused when a config is written (PUT /api/config, the
 * org PATCH) but an upgrade must never stop a gateway starting, so a config that repeats
 * a target still loads: the repeat is reported (a warning at load, the subject's
 * `problems` beside its chain, a `jinn doctor` line) and the expansion lists the target
 * once. Every other problem stays a load error.
 */

/** Decides whether a duplicate is tolerated; see `FallbackChainContext.onDuplicate`. */
export type DuplicateTolerance = (duplicate: FallbackChainDuplicate) => boolean;

// Warn once per message: loadConfig() runs again on every hot-reload.
const warned = new Set<string>();

/** At load: a duplicate is logged (once) and left to the expansion to dedupe. */
export function warnDuplicates(warn: (message: string) => void = (message) => logger.warn(message)): DuplicateTolerance {
  return ({ problem }) => {
    if (!warned.has(problem)) {
      warned.add(problem);
      warn(`${problem}; the repeat is ignored. Remove it from config.yaml.`);
    }
    return true;
  };
}

type Section = { fallback?: unknown; accounts?: unknown } | undefined;

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An engine or account chain, by its config path and the target it falls back from. */
interface ConfiguredChain {
  where: string;
  chain: unknown;
  self: { engine: string; profile?: string };
}

/** Every engine and declared-account chain of an `engines` mapping. */
function configuredChains(engines: unknown): ConfiguredChain[] {
  if (!isMapping(engines)) return [];
  const chains: ConfiguredChain[] = [];
  for (const name of ENGINE_NAMES) {
    const section = engines[name] as Section;
    if (!isMapping(section)) continue;
    chains.push({ where: `engines.${name}.fallback`, chain: section.fallback, self: { engine: name } });
    if (name !== "claude" || !isMapping(section.accounts)) continue;
    for (const [account, entry] of Object.entries(section.accounts)) {
      if (isMapping(entry)) chains.push({ where: `engines.claude.accounts.${account}.fallback`, chain: entry.fallback, self: { engine: "claude", profile: account } });
    }
  }
  return chains;
}

/** On a write: a duplicate in a chain the request leaves as the file has it, at the same path, is not the writer's to fix, so it must not block an unrelated save. */
export function unchangedDuplicates(existing: unknown): DuplicateTolerance {
  const before = new Map(configuredChains((existing as { engines?: unknown } | null)?.engines).map(({ where, chain }) => [where, JSON.stringify(chain)]));
  return ({ where, chain }) => before.get(where) === JSON.stringify(chain);
}

/**
 * The duplicates in the engine and account chains of an `engines` mapping, by the
 * config path of the chain (`engines.claude.fallback`, `engines.claude.accounts.A.fallback`),
 * in the wire module's words. Only duplicates: other problems are the validator's.
 */
export function duplicateProblemsByChain(engines: unknown): Record<string, string[]> {
  const profiles = accountNames(engines);
  const found: Record<string, string[]> = {};
  for (const { where, chain, self } of configuredChains(engines)) {
    const onDuplicate = ({ problem }: FallbackChainDuplicate): boolean => { (found[where] ??= []).push(problem); return true; };
    fallbackChainProblems(where, chain, { engines: ENGINE_NAMES, profiles, self, onDuplicate });
  }
  return found;
}
