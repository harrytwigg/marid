import { LEGACY_NAMES, NAMES, nameAliases, type Names } from "./codename.js";

/**
 * Environment variables carry the codename as a prefix (`JINN_HOME`). Operators set them
 * in service units, containers and shell profiles this program never rewrites, so a build
 * with another codename must keep reading the old names for as long as installs may carry them.
 *
 * The rule is one-directional and applied once, at each process entry: {@link adoptLegacyEnv}
 * copies every legacy-named variable that has no current-named twin onto the current name,
 * warning once per name. Everything after reads the current name only, and a variable set
 * under both names keeps the current value.
 */

/** `JINN_HOME` for the suffix `HOME`: the name this build reads and sets. */
export function envName(suffix: string, names: Names = NAMES): string {
  return `${names.upper}_${suffix}`;
}

/** Every spelling of one variable, the current one first. One name while no rename is in effect. */
export function envAliases(suffix: string, names: Names = NAMES): string[] {
  return nameAliases((n) => envName(suffix, n), names);
}

/** Every spelling of every suffix: what an allow-list or a scrub-list has to name once a name has an alias. */
export function envNamesFor(suffixes: readonly string[], names: Names = NAMES): string[] {
  return suffixes.flatMap((suffix) => envAliases(suffix, names));
}

/**
 * Set a variable under every spelling, in place. A child that has not adopted yet, or whose reader still
 * names the legacy variable, then agrees with this process about its value. One name while no rename is in effect.
 */
export function setEnv(env: NodeJS.ProcessEnv, suffix: string, value: string, names: Names = NAMES): void {
  for (const key of envAliases(suffix, names)) env[key] = value;
}

/** The first variable of `suffix` that is set, under the current name or else the legacy one. */
export function readEnv(
  env: NodeJS.ProcessEnv,
  suffix: string,
  names: Names = NAMES,
): string | undefined {
  for (const key of envAliases(suffix, names)) {
    const value = env[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

/** `HOME` out of `JINN_HOME` (or `_JINN_HOME`, which the container entry uses), or undefined for any other variable. */
function legacySuffixOf(key: string): { lead: string; suffix: string } | undefined {
  const lead = key.startsWith("_") ? "_" : "";
  const prefix = `${LEGACY_NAMES.upper}_`;
  const rest = key.slice(lead.length);
  return rest.startsWith(prefix) ? { lead, suffix: rest.slice(prefix.length) } : undefined;
}

export interface AdoptLegacyEnvOptions {
  names?: Names;
  /** Receives one line per adopted name. Defaults to `console.warn`. */
  warn?: (message: string) => void;
  /** Names already warned about; the default is shared by the whole process, so each name warns once. */
  warned?: Set<string>;
}

const warnedInProcess = new Set<string>();

/**
 * Give every legacy-named variable in `env` that has no current-named twin one, in place, and warn once per
 * name. Returns the legacy names it adopted; empty, and a no-op, while the codename is unchanged.
 */
export function adoptLegacyEnv(env: NodeJS.ProcessEnv, options: AdoptLegacyEnvOptions = {}): string[] {
  const names = options.names ?? NAMES;
  if (!names.renamed) return [];
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const warned = options.warned ?? warnedInProcess;
  const adopted: string[] = [];
  for (const key of Object.keys(env)) {
    const current = currentTwinOf(key, env, names);
    if (current === undefined) continue;
    // Only a variable somebody set under the old name alone is news. One set under both names (the gateway exports
    // both to what it spawns) is already in step with this build, and warning about it would say nothing true.
    if (env[current] !== undefined) continue;
    env[current] = env[key];
    adopted.push(key);
    if (!warned.has(key)) {
      warned.add(key);
      warn(`Environment variable ${key} is deprecated: set ${current} instead.`);
    }
  }
  return adopted;
}

/** The current name of a legacy-named variable that is set, or undefined for any other variable. */
function currentTwinOf(key: string, env: NodeJS.ProcessEnv, names: Names): string | undefined {
  const legacy = legacySuffixOf(key);
  return legacy && env[key] !== undefined ? `${legacy.lead}${envName(legacy.suffix, names)}` : undefined;
}

/** Whether `key` is a variable of this program under either codename: `JINN_*` or the current prefix. */
export function isCodenameEnvKey(key: string, names: Names = NAMES): boolean {
  const bare = key.startsWith("_") ? key.slice(1) : key;
  return bare.startsWith(`${names.upper}_`) || bare.startsWith(`${LEGACY_NAMES.upper}_`);
}
