import { logger } from "./logger.js";
import type { FallbackChainDuplicate } from "./fallback-chain-wire.js";

/**
 * Duplicate chain entries are refused when a config is written (PUT /api/config, the
 * org PATCH) but an upgrade must never stop a gateway starting, so what the legacy
 * validator accepted stays loadable: a string entry listed twice. The expansion lists
 * a target once, so the repeat is harmless. Anything only the object form can say
 * (a repeated mapping) stays an error everywhere.
 */

/** Decides whether a duplicate is tolerated; see `FallbackChainContext.onDuplicate`. */
export type DuplicateTolerance = (duplicate: FallbackChainDuplicate) => boolean;

/** Both entries are legacy strings: the one duplicate the old validator accepted. */
function legacyDuplicate({ chain, index, first }: FallbackChainDuplicate): boolean {
  return typeof chain[index] === "string" && typeof chain[first] === "string";
}

// Warn once per message: loadConfig() runs again on every hot-reload.
const warned = new Set<string>();

/** At load: a legacy string duplicate is logged (once) and left to the expansion to dedupe. */
export function warnLegacyDuplicates(warn: (message: string) => void = (message) => logger.warn(message)): DuplicateTolerance {
  return (duplicate) => {
    if (!legacyDuplicate(duplicate)) return false;
    if (!warned.has(duplicate.problem)) {
      warned.add(duplicate.problem);
      warn(`${duplicate.problem}; the repeat is ignored. Remove it from config.yaml.`);
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

/** On a write: a legacy string duplicate in a chain the request leaves as the file has it is not the writer's to fix, so it must not block an unrelated save. */
export function unchangedLegacyDuplicates(existing: unknown): DuplicateTolerance {
  const unchanged = new Set(chainsOf(existing));
  return (duplicate) => legacyDuplicate(duplicate) && unchanged.has(JSON.stringify(duplicate.chain));
}
