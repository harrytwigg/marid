import { LEGACY_CODENAME, NAMES, type Names } from "../shared/codename.js";

/**
 * The deprecation line the legacy binary prints before it hands over to the current one, or
 * undefined while the two names are the same (the legacy binary then is the current one).
 * Printed on stderr, so a script reading the command's stdout is unaffected.
 */
export function forwarderNotice(names: Names = NAMES): string | undefined {
  if (!names.renamed) return undefined;
  return `\`${LEGACY_CODENAME}\` has been renamed \`${names.codename}\`. The old name still works for now; use \`${names.codename}\` from here on.`;
}

/** The module the forwarder hands over to: the current binary's entry, next to the forwarder's own. */
export function forwardTarget(names: Names = NAMES): string {
  return `./${names.codename}.js`;
}
