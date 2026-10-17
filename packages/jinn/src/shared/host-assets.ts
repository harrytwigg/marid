import fs from "node:fs";
import { NAMES, type Names } from "./codename.js";

/**
 * The hook relay runs outside this package (beside the home, and staged onto remote hosts),
 * so it cannot import the codename: the placeholder in `assets/hook-relay.mjs` is replaced
 * as each copy is written. The first line of the copy states the codename it was written for,
 * which is how a remote host's older copy is recognised as stale and staged again.
 */
const PLACEHOLDER = /__CODENAME__/g;

/** `// codename: jinn`, the line a rendered relay carries. */
export function hostAssetStamp(names: Names = NAMES): string {
  return `// codename: ${names.codename}`;
}

/** The asset's source with the codename in place. */
export function renderHostAsset(source: string, names: Names = NAMES): string {
  return source.replace(PLACEHOLDER, names.codename);
}

/** Read a shipped asset from `file` and render it for `names`. */
export function readHostAsset(file: string, names: Names = NAMES): string {
  return renderHostAsset(fs.readFileSync(file, "utf-8"), names);
}

/**
 * A fragment for the farm scripts' "is this asset really there" test, to follow the `[ -f ]`
 * checks. While the codename is unchanged every copy that exists is current, so it is empty.
 * Once it changes, a relay without this build's stamp counts as missing and is staged again.
 */
export function relayStampShellCheck(shellQuote: (value: string) => string, names: Names = NAMES): string {
  if (!names.renamed) return "";
  return ` && { [ "$a" != hook-relay.mjs ] || grep -qF ${shellQuote(hostAssetStamp(names))} "$root/$a"; }`;
}
