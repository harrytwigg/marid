#!/usr/bin/env node
import { exitCodeFor, spawnLowPriority } from "./low-priority.mjs";

/**
 * Runs the monorepo's package test tasks — `turbo run test` — at idle scheduling
 * priority.
 *
 * It exists, rather than being one line of package.json, because the one thing
 * that differs between CI and a developer's machine is a flag: a package script
 * runs through cmd.exe on Windows as well as sh, and there is no conditional that
 * reads the same in both, so the flag is chosen in JavaScript.
 *
 *   - turbo runs serial in CI (`--concurrency=1`) and at its own default here, so
 *     the four package suites can be in flight together. They bound themselves:
 *     each vitest suite caps its own forks in its own vitest.config.ts, and
 *     scripts/test-slot-gate.mjs caps how many suites run at once machine-wide.
 *   - CI runs unwrapped: there is nothing on a dedicated runner to yield to, and
 *     low-priority.mjs no-ops there anyway.
 *
 * vitest's worker count is deliberately not set here — a second copy of that
 * decision is a second place to get it wrong.
 */

/** The turbo subcommand for this environment: serial in CI, default locally. */
export function turboArgs({ env = process.env } = {}) {
  return env.CI ? ["run", "test", "--concurrency=1"] : ["run", "test"];
}

function main() {
  const argv = ["turbo", ...turboArgs()];
  console.log(`run-package-tests: ${argv.join(" ")}`);
  const result = spawnLowPriority(argv, { stdio: "inherit" });
  if (result.error) {
    console.error(`run-package-tests: could not start ${argv[0]} — ${result.error.message}`);
    return 1;
  }
  return exitCodeFor(result);
}

if (import.meta.main) {
  process.exit(main());
}
