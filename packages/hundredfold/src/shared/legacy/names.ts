/**
 * The names an install made before the rename carries, as the compatibility layer reads them. The values live in
 * `names.json` so that code, tests and scripts alike take them from one file; nothing else spells them.
 */
import legacy from "./names.json" with { type: "json" };

/** The lower-case codename an old install is built from: its home, instance names, headers and variables. */
export const LEGACY_CODENAME: string = legacy.codename;
/** The portal and company name an instance that never set its own has always run under. */
export const LEGACY_PORTAL_NAME: string = legacy.portalName;
/** What an older build called the product, in its version banner. */
export const LEGACY_PRODUCT_NAME: string = legacy.productName;
/** What an older build's banner said it was built on. */
export const LEGACY_UPSTREAM_NAME: string = legacy.upstreamName;
/** The npm package an old install was published as. */
export const LEGACY_PACKAGE: string = legacy.package;
/** The environment-variable prefixes an old build read (without the underscore). */
export const LEGACY_ENV_PREFIXES: readonly string[] = legacy.envPrefixes;
/** SQLite functions an existing database's schema names, which must keep resolving under these names. */
export const LEGACY_SQL_FUNCTIONS: Readonly<{ callbackIdentity: string; claimDigest: string; claimPrefix: string }> = legacy.sqlFunctions;
/** Browser storage keys written before the rename that are read once and not copied by prefix. */
export const LEGACY_STORAGE_KEYS: Readonly<{ pinnedSessions: string; activeOrigin: string }> = legacy.storageKeys;

/** The old name in each form a fixture needs, so a test of how an old install is read never spells it. */
export const OLD = {
  codename: LEGACY_CODENAME,
  upper: LEGACY_CODENAME.toUpperCase(),
  title: LEGACY_CODENAME.charAt(0).toUpperCase() + LEGACY_CODENAME.slice(1),
  portalName: LEGACY_PORTAL_NAME,
  productName: LEGACY_PRODUCT_NAME,
  upstreamName: LEGACY_UPSTREAM_NAME,
  package: LEGACY_PACKAGE,
  envPrefixes: LEGACY_ENV_PREFIXES,
  sqlFunctions: LEGACY_SQL_FUNCTIONS,
  storageKeys: LEGACY_STORAGE_KEYS,
} as const;
