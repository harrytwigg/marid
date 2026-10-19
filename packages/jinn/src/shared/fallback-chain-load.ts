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

function chainsOf(config: unknown): string[] {
  const engines = (config as { engines?: Record<string, { fallback?: unknown; accounts?: Record<string, { fallback?: unknown } | null> } | null> } | null)?.engines;
  if (typeof engines !== "object" || engines === null) return [];
  const chains = Object.values(engines).flatMap((section) => [section?.fallback, ...Object.values(section?.accounts ?? {}).map((account) => account?.fallback)]);
  return chains.filter(Array.isArray).map((chain) => JSON.stringify(chain));
}

/** On a write: a duplicate in a chain the request leaves as the file has it is not the writer's to fix, so it must not block an unrelated save. */
export function unchangedDuplicates(existing: unknown): DuplicateTolerance {
  const unchanged = new Set(chainsOf(existing));
  return ({ chain }) => unchanged.has(JSON.stringify(chain));
}

type Section = { fallback?: unknown; accounts?: unknown } | undefined;

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The duplicates in the engine and account chains of an `engines` mapping, by the
 * config path of the chain (`engines.claude.fallback`, `engines.claude.accounts.A.fallback`),
 * in the wire module's words. Only duplicates: other problems are the validator's.
 */
export function duplicateProblemsByChain(engines: unknown): Record<string, string[]> {
  if (!isMapping(engines)) return {};
  const profiles = accountNames(engines);
  const found: Record<string, string[]> = {};
  const scan = (where: string, chain: unknown, self: { engine: string; profile?: string }): void => {
    const onDuplicate = ({ problem }: FallbackChainDuplicate): boolean => { (found[where] ??= []).push(problem); return true; };
    fallbackChainProblems(where, chain, { engines: ENGINE_NAMES, profiles, self, onDuplicate });
  };
  for (const name of ENGINE_NAMES) {
    const section = engines[name] as Section;
    if (!isMapping(section)) continue;
    scan(`engines.${name}.fallback`, section.fallback, { engine: name });
    if (name !== "claude" || !isMapping(section.accounts)) continue;
    for (const [account, entry] of Object.entries(section.accounts)) {
      if (isMapping(entry)) scan(`engines.claude.accounts.${account}.fallback`, entry.fallback, { engine: "claude", profile: account });
    }
  }
  return found;
}
