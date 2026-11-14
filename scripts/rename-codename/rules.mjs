// What the codename rename leaves alone, and why. Every entry is a decision, not a convenience: the
// guard (`node scripts/rename-codename.mjs --check`) fails on any old name outside this list.

/**
 * Text that keeps its old spelling wherever it appears. Each is matched inside a line; the rest of the
 * line is still rewritten.
 */
export const KEEP_PATTERNS = [
  // Attribution the licence asks for, and the links to upstream.
  /fork of \[?Jinn\]?/g,
  /Jinn Contributors/g,
  /hristo2612\/jinn/g,
  // The old command a package still installs, so a script that runs it keeps working for the compatibility window.
  /"jinn": "\.\/dist\/bin\/legacy-forwarder\.js"/g,
];



/** Paths whose content is never rewritten (a path in this list is still allowed to hold the old name). */
export const KEEP_CONTENT_PATHS = [
  // Released history: past sections, and the bundles an installed instance upgrades from.
  /^CHANGELOG\.md$/,
  /^packages\/[^/]+\/template\/migrations\//,
  // The skills as an earlier release shipped them, which the tests compare a stored copy against byte for byte.
  /^packages\/[^/]+\/src\/migrations\/__tests__\/fixtures\/v\d/,
  // The one place the old names are spelled, for the compatibility layer.
  /^packages\/[^/]+\/src\/shared\/legacy-names\.json$/,
  // Regenerated, not edited.
  /^pnpm-lock\.yaml$/,
  // The licence and the notice carry the attribution; they are edited by hand.
  /^(?:packages\/[^/]+\/)?(?:LICENSE|NOTICE)$/,
];

/** Path prefixes whose own name is kept while everything under them moves with the package. */
export const FROZEN_SUBTREES = [
  // The content inside a released bundle is instance-file layout: it never moves.
  /^packages\/jinn\/template\/migrations\/[^/]+\/files\//,
];


