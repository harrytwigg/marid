/**
 * The environment variables a parsed config.yaml refers to as `${VAR}` or `$VAR` in any string value, outside the keys
 * an opencode account holds (`engines.opencode.accounts`, whose `keyEnv` is a plain name, not a reference).
 *
 * The gateway takes each declared account key out of its own environment at load and withholds it from every other
 * process, so a variable something else in the config still expands from would be unset there.
 */

const REFERENCE_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)[^}]*\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

function collect(value: unknown, into: Set<string>): void {
  if (typeof value === "string") {
    for (const match of value.matchAll(REFERENCE_RE)) into.add((match[1] ?? match[2])!);
  } else if (Array.isArray(value)) {
    for (const item of value) collect(item, into);
  } else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) collect(item, into);
  }
}

/** Every variable name `config` expands from. */
export function configEnvReferences(config: Record<string, unknown>): Set<string> {
  const found = new Set<string>();
  const { engines, ...rest } = config;
  collect(rest, found);
  if (typeof engines === "object" && engines !== null && !Array.isArray(engines)) {
    const { opencode, ...otherEngines } = engines as Record<string, unknown>;
    collect(otherEngines, found);
    if (typeof opencode === "object" && opencode !== null && !Array.isArray(opencode)) {
      const { accounts: _accounts, ...opencodeRest } = opencode as Record<string, unknown>;
      collect(opencodeRest, found);
    } else {
      collect(opencode, found);
    }
  }
  return found;
}
