// What the codename rename leaves alone, and why. Every entry is a decision, not a convenience: the
// guard (`node scripts/rename-codename.mjs --check`) fails on any old name outside this list.

/**
 * Text that keeps its old spelling wherever it appears. Each is matched inside a line; the rest of the
 * line is still rewritten.
 */
export const KEEP_PATTERNS = [
  // Attribution the licence asks for, and the links to upstream.
  /built on Jinn/g,
  /fork of \[?Jinn\]?/g,
  /upstream Jinn/g,
  /Jinn upstream/g,
  /Jinn Contributors/g,
  /hristo2612\/jinn/g,
  // App identity: a new bundle id is a new app, so the ids, the Java package dirs and the old URL scheme stay.
  /run\.jinn\.shell(?:\.gateway)?/g,
  /run\/jinn\/shell/g,
  /jinn:\/\//g,
  // Names a database schema or a stored value refers to. Renaming them would invalidate stored data.
  /jinn_callback_identity/g,
  /jinn_work_item_claim_[a-z_]+/g,
  // Docker: the volumes hold the data and the mount point is where a home lives in a container.
  /jinn-(?:home|claude|codex)\b/g,
  /\/home\/node\/\.jinn\b/g,
  // The word the image's CMD, the compose command and the entrypoint agree on; nothing outside them reads it.
  /__jinn_service_start__/g,
];

/**
 * Names that belong to how the product is installed and published. The distribution step moves them; until
 * it has, `--skip-distribution` leaves them as they are.
 */
export const DISTRIBUTION_PATTERNS = [/jinn-cli/g, /release-jinn-cli/g];
export const DISTRIBUTION_PATHS = [
  /^Formula\//,
  /^\.github\/workflows\/(?:bump-formula|publish-npm)\.yml$/,
  /^\.claude\/skills\/release-jinn-cli\//,
  /^docker-compose\.yml$/,
];

/** Paths whose content is never rewritten (a path in this list is still allowed to hold the old name). */
export const KEEP_CONTENT_PATHS = [
  // Released history: past sections, and the bundles an installed instance upgrades from.
  /^CHANGELOG\.md$/,
  /^packages\/[^/]+\/template\/migrations\//,
  // Regenerated, not edited.
  /^pnpm-lock\.yaml$/,
  // The licence and the notice carry the attribution; they are edited by hand.
  /^(?:packages\/[^/]+\/)?(?:LICENSE|NOTICE)$/,
  // Platform projects tauri generates; their names derive from the crate and the bundle id, both kept.
  /^packages\/shell\/src-tauri\/gen\//,
];

/** Path prefixes whose own name is kept while everything under them moves with the package. */
export const FROZEN_SUBTREES = [
  // The content inside a released bundle is instance-file layout: it never moves.
  /^packages\/jinn\/template\/migrations\/[^/]+\/files\//,
];

/** Name-keeping subtrees: the part after the match keeps its file and directory names. */
FROZEN_SUBTREES.push(/^packages\/shell\/src-tauri\/gen\//);

/**
 * The documentation step moves these. While it has not run, `--skip-docs` leaves them out of both the rewrite
 * and the guard; once it has, the flag goes from the CI step.
 */
export const DOCS_SCOPE = [
  /^docs\//,
  /^specs\//,
  /^\.specify\//,
  /^\.plans\//,
  /^\.claude\/skills\//,
  /^AGENTS\.md$/,
  /^README\.md$/,
  /^TESTING\.md$/,
  /^THIRD-PARTY-NOTICES\.md$/,
  /^\.github\/CONTRIBUTING\.md$/,
  /^packages\/[^/]+\/(?:README|TESTING|THIRD-PARTY-NOTICES)\.md$/,
  /^examples\/.*\.md$/,
];
