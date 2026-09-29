/** The product name users see. "Jinn" stays the internal codename (identifiers,
 *  env vars, paths, the `jinn` binary); only human-facing output reads from here. */
export const PRODUCT_NAME = "Marid";

/** e.g. "Marid 0.33.3 (built on Jinn)". */
export function productBanner(version: string): string {
  return `${PRODUCT_NAME} ${version} (built on Jinn)`;
}
