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
  /(?<![-\w/])jinn-(?:home|claude|codex)(?![-\w])/g,
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

/**
 * Tests whose subject is the old name: an install made before the rename, or a build that says another codename and
 * so has an old one. Their fixtures hold the old spelling on purpose. Names that follow an API (a renamed function or
 * package scope) were moved by hand.
 */
export const LEGACY_FIXTURE_TESTS = [
  "packages/hundredfold/src/accounts/__tests__/member-session-leak.test.ts",
  "packages/hundredfold/src/board-walk/__tests__/snapshot.test.ts",
  "packages/hundredfold/src/board-walk/__tests__/walk.test.ts",
  "packages/hundredfold/src/cli/__tests__/legacy-forwarder.test.ts",
  "packages/hundredfold/src/cli/__tests__/restart.test.ts",
  "packages/hundredfold/src/engines/__tests__/musecode-codename.test.ts",
  "packages/hundredfold/src/engines/__tests__/opencode-internal-fallback-remote.test.ts",
  "packages/hundredfold/src/engines/__tests__/opencode-internal-fallback.test.ts",
  "packages/hundredfold/src/engines/__tests__/remote-stage-rename.test.ts",
  "packages/hundredfold/src/gateway/__tests__/auth-state-legacy-cookie.test.ts",
  "packages/hundredfold/src/gateway/__tests__/codename-wire-renamed.test.ts",
  "packages/hundredfold/src/gateway/__tests__/org-router-contract.test.ts",
  "packages/hundredfold/src/instances/create.test.ts",
  "packages/hundredfold/src/instances/__tests__/home-rename-recovery.test.ts",
  "packages/hundredfold/src/instances/__tests__/home-rename.test.ts",
  "packages/hundredfold/src/instances/__tests__/identity-renamed.test.ts",
  "packages/hundredfold/src/instances/__tests__/stage-rename.test.ts",
  "packages/hundredfold/src/instances/__tests__/switchover.test.ts",
  "packages/hundredfold/src/mcp/__tests__/builtin-name-renamed.test.ts",
  "packages/hundredfold/src/migrations/__tests__/sync-template-skills-renamed.test.ts",
  "packages/hundredfold/src/search/__tests__/query-grammar.test.ts",
  "packages/hundredfold/src/sessions/__tests__/context.test.ts",
  "packages/hundredfold/src/sessions/__tests__/engine-run-mcp-renamed.test.ts",
  "packages/hundredfold/src/shared/__tests__/codename-env.test.ts",
  "packages/hundredfold/src/shared/__tests__/codename-persisted-renamed.test.ts",
  "packages/hundredfold/src/shared/__tests__/codename.test.ts",
  "packages/hundredfold/src/shared/__tests__/command-policy.test.ts",
  "packages/hundredfold/src/shared/__tests__/engine-health-opencode.test.ts",
  "packages/hundredfold/src/shared/__tests__/homebrew-formula.test.ts",
  "packages/hundredfold/src/shared/__tests__/opencode-subscription.test.ts",
  "packages/hundredfold/src/shared/__tests__/template-materialization.test.ts",
  "packages/hundredfold/src/shared/__tests__/wire-names.test.ts",
  "packages/hundredfold/src/talk/session/__tests__/brief.test.ts",
  "packages/hundredfold/src/work-items/__tests__/id-prefix.test.ts",
  "packages/hundredfold/src/work-items/__tests__/respawn-guards.test.ts",
  "packages/web/src/components/chat/__tests__/employee-picker.test.tsx",
  "packages/web/src/components/talk/context/__tests__/live-chat-context.test.ts",
  "packages/web/src/components/talk/context/__tests__/render-page-context.test.ts",
  "packages/web/src/lib/__tests__/codename.test.ts",
  "packages/web/src/lib/__tests__/legacy-storage.test.ts",
  "packages/web/src/plugins/__tests__/runtime-loader-renamed.test.ts",
  "scripts/__tests__/check-footguns.test.mjs",
];

/** Paths whose content is never rewritten (a path in this list is still allowed to hold the old name). */
export const KEEP_CONTENT_PATHS = [
  { test: (file) => LEGACY_FIXTURE_TESTS.includes(file) },
  // Released history: past sections, and the bundles an installed instance upgrades from.
  /^CHANGELOG\.md$/,
  /^packages\/[^/]+\/template\/migrations\//,
  // The skills as an earlier release shipped them, which the tests compare a stored copy against byte for byte.
  /^packages\/[^/]+\/src\/migrations\/__tests__\/fixtures\/v\d/,
  // Regenerated, not edited.
  /^pnpm-lock\.yaml$/,
  // The licence and the notice carry the attribution; they are edited by hand.
  /^(?:packages\/[^/]+\/)?(?:LICENSE|NOTICE)$/,
  // The upgrade rehearsal builds an install under the old names on purpose, then checks the new build moves it.
  /^scripts\/verify-codename-upgrade(?:-lib\.mjs|-claude\.cjs|\.mjs)$/,
  // The shell's config registers the old URL scheme beside the new one, and keeps the old bundle id.
  /^packages\/shell\/src-tauri\/tauri\.conf\.json$/,
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
