/** The product name users see. "Jinn" stays the internal codename (identifiers,
 *  env vars, paths, the `jinn` binary); only human-facing output reads from here. */
export const PRODUCT_NAME = "Marid";

/** e.g. "Marid 0.33.3 (built on Jinn)". */
export function productBanner(version: string): string {
  return `${PRODUCT_NAME} ${version} (built on Jinn)`;
}

const VERSION_PATTERN = "\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]+)?";
const BARE_VERSION = new RegExp(`^(${VERSION_PATTERN})$`);
const BANNER_VERSION = new RegExp(`^${PRODUCT_NAME} (${VERSION_PATTERN}) \\(built on Jinn\\)$`);

/** Inverse of `productBanner`: the version out of a `jinn --version` line.
 *  Accepts the current banner and the bare `X.Y.Z` that builds from before the
 *  rebrand print; anything else is not a version we can compare, so undefined. */
export function parseVersionOutput(line: string): string | undefined {
  const text = line.trim();
  return (BANNER_VERSION.exec(text) ?? BARE_VERSION.exec(text))?.[1];
}
