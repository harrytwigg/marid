/** The product name users see. "Hundredfold" stays the internal codename (identifiers,
 *  env vars, paths, the `hundredfold` binary); only human-facing output reads from here. */
export const PRODUCT_NAME = "Hundredfold";

/** The portal (COO) and company name an instance that never set `portal.portalName` or
 *  `portal.companyName` has always run under. Sessions, Todos and the org root are filed under it,
 *  so a build that changed it would orphan that data: it stays as it was. A new instance writes
 *  {@link PRODUCT_NAME} into its config instead (cli/setup.ts). */
export const LEGACY_PORTAL_NAME = "Jinn"; // rename:keep

/** e.g. "Hundredfold 0.33.3 (built on Jinn)". */
export function productBanner(version: string): string {
  return `${PRODUCT_NAME} ${version} (built on Jinn)`;
}

const VERSION_PATTERN = "\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]+)?";
const BARE_VERSION = new RegExp(`^(${VERSION_PATTERN})$`);
/** What builds from before the rename called the product in their banner. A host still on one prints it. */
const LEGACY_PRODUCT_NAME = "Marid"; // rename:keep
const BANNER_VERSION = new RegExp(`^(?:${PRODUCT_NAME}|${LEGACY_PRODUCT_NAME}) (${VERSION_PATTERN}) \\(built on Jinn\\)$`);

/** Inverse of `productBanner`: the version out of a `hundredfold --version` line.
 *  Accepts the current banner, the one before the rename and the bare `X.Y.Z` that builds from before the
 *  rebrand print; anything else is not a version we can compare, so undefined. */
export function parseVersionOutput(line: string): string | undefined {
  const text = line.trim();
  return (BANNER_VERSION.exec(text) ?? BARE_VERSION.exec(text))?.[1];
}
