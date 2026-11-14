// What the codename rename leaves alone, and why. Every entry is a decision, not a convenience: the
// guard (`node scripts/rename-codename.mjs --check`) fails on any old name outside this list. The old names are read
// from the one file that spells them (packages/hundredfold/src/shared/legacy/names.json), so nothing here does.
import fs from "node:fs";
import { LEGACY } from "./engine.mjs";

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const upstreamName = escape(LEGACY.upstreamName);
const codename = escape(LEGACY.codename);

const readme = /^README\.md$/;
const licence = /^(?:packages\/[^/]+\/)?(?:LICENSE|NOTICE)$/;
const portalName = escape(LEGACY.portalName);

/**
 * Text that keeps its old spelling, and the files it may keep it in. Each is matched inside a line; the rest of the
 * line is still rewritten. A pattern outside its files is renamed like everything else.
 */
const KEEP = [
  // The credit the licence asks for, in the files that carry it.
  { pattern: new RegExp(`fork of \\[?${upstreamName}\\]?`, "g"), files: [readme, licence] },
  { pattern: new RegExp(`${upstreamName} Contributors`, "g"), files: [readme, licence] },
  { pattern: new RegExp(`hristo2612/${codename}`, "g"), files: [readme, licence] },
  // The old command a package still installs, so a script that runs it keeps working for the compatibility window.
  { pattern: new RegExp(`"${codename}": "\\./dist/bin/legacy-forwarder\\.js"`, "g"), files: [/^packages\/hundredfold\/package\.json$/] },
  // What an instance with no portal name of its own is materialized as, said once in each generated migration record.
  { pattern: new RegExp(`\\(default \`${portalName}\`\\)`, "g"), files: [/^packages\/hundredfold\/template\/migrations\/[^/]+\/MIGRATION\.md$/] },
];

export const KEEP_PATTERNS = KEEP.map((entry) => entry.pattern);

/** The patterns that may keep their old spelling in `file`. */
export function keepPatternsFor(file) {
  return KEEP.filter((entry) => entry.files.some((rule) => rule.test(file))).map((entry) => entry.pattern);
}

const BUNDLE = /^packages\/hundredfold\/template\/migrations\/(\d+)\.(\d+)\.(\d+)\/(.*)$/;
const current = (() => {
  const [major, minor, patch] = JSON.parse(fs.readFileSync(new URL("../../packages/hundredfold/package.json", import.meta.url), "utf8")).version.split(/[.-]/).map(Number);
  return [major, minor, patch];
})();

/**
 * A bundle that has been released is the layout an installed instance upgrades from, so it never changes. The bundle
 * of the version being built is not released yet: only the base payload in it is (the template as the last release
 * shipped it), and its rationale and target must say what this release does.
 */
function releasedBundleFile(file) {
  const match = BUNDLE.exec(file);
  if (!match) return false;
  const version = match.slice(1, 4).map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (version[i] !== current[i]) return version[i] < current[i];
  }
  return match[4].startsWith("files/base/");
}

/** Paths whose content is never rewritten (a path in this list is still allowed to hold the old name). */
const KEEP_CONTENT_PATHS = [
  // Released history: past sections.
  /^CHANGELOG\.md$/,
  // The skills as an earlier release shipped them, which the tests compare a stored copy against byte for byte.
  /^packages\/hundredfold\/src\/migrations\/__tests__\/fixtures\/v\d/,
  // The one place the old names are spelled, for the compatibility layer.
  /^packages\/hundredfold\/src\/shared\/legacy\//,
  // The one page that explains the upgrade to someone who knows the old names.
  /^docs\/upgrading\.md$/,
  // Regenerated, not edited.
  /^pnpm-lock\.yaml$/,
  // The licence and the notice carry the credit; they are edited by hand.
  licence,
];

export function keepContent(file) {
  return releasedBundleFile(file) || KEEP_CONTENT_PATHS.some((rule) => rule.test(file));
}

/** Path prefixes whose own name is kept while everything under them moves with the package. */
export const FROZEN_SUBTREES = [
  // The content inside a bundle is instance-file layout: a base payload never moves, and a target's paths are already the new ones.
  /^packages\/hundredfold\/template\/migrations\/[^/]+\/files\//,
];
