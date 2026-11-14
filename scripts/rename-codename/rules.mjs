// What the codename rename leaves alone, and why. Every entry is a decision, not a convenience: the
// guard (`node scripts/rename-codename.mjs --check`) fails on any old name outside this list. The old names are read
// from the one file that spells them (packages/hundredfold/src/shared/legacy/names.json), so nothing here does.
import { LEGACY } from "./engine.mjs";

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const upstreamName = escape(LEGACY.upstreamName);
const codename = escape(LEGACY.codename);

/**
 * Text that keeps its old spelling wherever it appears: the credit the licence asks for. Each is matched inside a
 * line; the rest of the line is still rewritten.
 */
export const KEEP_PATTERNS = [
  new RegExp(`fork of \\[?${upstreamName}\\]?`, "g"),
  new RegExp(`${upstreamName} Contributors`, "g"),
  new RegExp(`hristo2612/${codename}`, "g"),
  // The old command a package still installs, so a script that runs it keeps working for the compatibility window.
  new RegExp(`"${codename}": "\\./dist/bin/legacy-forwarder\\.js"`, "g"),
];

/** Paths whose content is never rewritten (a path in this list is still allowed to hold the old name). */
export const KEEP_CONTENT_PATHS = [
  // Released history: past sections, and the bundles an installed instance upgrades from.
  /^CHANGELOG\.md$/,
  /^packages\/[^/]+\/template\/migrations\//,
  // The skills as an earlier release shipped them, which the tests compare a stored copy against byte for byte.
  /^packages\/[^/]+\/src\/migrations\/__tests__\/fixtures\/v\d/,
  // The one place the old names are spelled, for the compatibility layer.
  /^packages\/[^/]+\/src\/shared\/legacy\//,
  // The one page that explains the upgrade to someone who knows the old names.
  /^docs\/upgrading\.md$/,
  // Regenerated, not edited.
  /^pnpm-lock\.yaml$/,
  // The licence and the notice carry the credit; they are edited by hand.
  /^(?:packages\/[^/]+\/)?(?:LICENSE|NOTICE)$/,
];

/** Path prefixes whose own name is kept while everything under them moves with the package. */
export const FROZEN_SUBTREES = [
  // The content inside a released bundle is instance-file layout: it never moves.
  /^packages\/hundredfold\/template\/migrations\/[^/]+\/files\//,
];
