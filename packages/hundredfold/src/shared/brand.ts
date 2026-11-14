import { LEGACY_PORTAL_NAME, LEGACY_PRODUCT_NAME, LEGACY_UPSTREAM_NAME } from "./legacy-names.js";

export { LEGACY_PORTAL_NAME };

/** The product name users see. Names the program builds for itself (identifiers, environment variables, paths,
 *  headers) come from the codename instead (codename.ts); only human-facing output reads from here. */
export const PRODUCT_NAME = "Hundredfold";

/** e.g. "Hundredfold 0.34.0". */
export function productBanner(version: string): string {
  return `${PRODUCT_NAME} ${version}`;
}

const VERSION_PATTERN = "\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]+)?";
const BARE_VERSION = new RegExp(`^(${VERSION_PATTERN})$`);
const BANNER_VERSION = new RegExp(`^${PRODUCT_NAME} (${VERSION_PATTERN})$`);
/** What builds from before the rename printed: their product name and what they said they were built on. A host
 *  still on one prints it. */
const OLDER_BANNER_VERSION = new RegExp(`^${LEGACY_PRODUCT_NAME} (${VERSION_PATTERN}) \\(built on ${LEGACY_UPSTREAM_NAME}\\)$`);

/** Inverse of `productBanner`: the version out of a `hundredfold --version` line.
 *  Accepts the current banner, the one before the rename and the bare `X.Y.Z` that builds from before the
 *  rebrand print; anything else is not a version we can compare, so undefined. */
export function parseVersionOutput(line: string): string | undefined {
  const text = line.trim();
  return (BANNER_VERSION.exec(text) ?? OLDER_BANNER_VERSION.exec(text) ?? BARE_VERSION.exec(text))?.[1];
}
