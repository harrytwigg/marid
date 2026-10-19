#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Runs a command at the lowest CPU and I/O scheduling priority.
 *
 * The local suites were kept in their box by capping how much of the machine
 * they could take: turbo serial, vitest on two workers, and a machine-wide cap
 * of two suites. That works, but it also leaves `pnpm test` on an idle machine
 * slower than it has any reason to be. Priority is the better lever — a run at
 * nice 19 in the idle I/O class takes the cores when nothing else wants them and
 * yields the moment an editor, a gateway or a person does.
 *
 * The wrapping is applied twice: around the root `turbo run test`, so every
 * package suite inherits it, and inside scripts/vitest-flaky-retry.mjs, so a
 * single package's suite is just as polite when it is run on its own.
 *
 * It is a no-op in three cases, each for its own reason:
 *   - CI. The runner is dedicated to the job, so there is nothing to yield to,
 *     and the worker caps there are deliberate.
 *   - JINN_TEST_NICE=0. The escape hatch for a run that has to have normal
 *     priority, and the switch the tests use to prove the no-op path.
 *   - Windows, which has neither nice(1) nor ionice(1).
 *
 * JINN_TEST_LOW_PRIORITY=1 rides along on the child's environment so
 * packages/jinn/vitest.config.ts can widen its timeouts: 5s is generous on an
 * idle core and is not on a loaded one, and a false red at nice 19 is worse than
 * a slow green.
 */

export const LOW_PRIORITY_ENV = "JINN_TEST_LOW_PRIORITY";
export const NICE_LEVEL = 19;
export const IONICE_CLASS = 3;

/**
 * Whether a run of `argv` should be niced. Environment and platform are
 * parameters so a test can ask the question without touching either.
 */
export function lowPriorityEnabled({ env = process.env, platform = process.platform } = {}) {
  if (env.CI) return false;
  if (env.JINN_TEST_NICE === "0") return false;
  return platform !== "win32";
}

function canExecute(candidate, platform) {
  try {
    // X_OK is meaningless on Windows, where every readable file is runnable.
    fs.accessSync(candidate, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch {
    // Not there, or not executable.
    return false;
  }
}

/** First executable named `name` on PATH, or null. */
export function findExecutable(name, { env = process.env, platform = process.platform } = {}) {
  const pathVar = platform === "win32" ? env.PATH ?? env.Path : env.PATH;
  if (!pathVar) return null;
  const dirs = pathVar.split(platform === "win32" ? ";" : ":").filter(Boolean);
  return dirs.map((dir) => path.join(dir, name)).find((candidate) => canExecute(candidate, platform)) ?? null;
}

/**
 * The command line that puts `argv` at idle priority: nice(1) is the floor for
 * CPU, ionice(1) the idle class for disk. ionice is Linux-only, so it is used
 * only when it is actually on PATH — on the Mac it is not, and the CPU half is
 * still worth having.
 */
export function lowPrioritySpawnSpec(argv, { platform = process.platform, hasIonice = false } = {}) {
  if (platform === "win32") {
    return { command: argv[0], args: argv.slice(1) };
  }
  const wrapper = ["-n", String(NICE_LEVEL)];
  if (hasIonice) wrapper.push("ionice", "-c", String(IONICE_CLASS));
  return { command: "nice", args: [...wrapper, ...argv] };
}

/**
 * spawnSync, at idle priority when that path is active and unchanged when it is
 * not. Returns spawnSync's own result, so callers read status, signal and error
 * exactly as they did before.
 *
 * @param {string[]} argv
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   platform?: NodeJS.Platform,
 *   ionice?: boolean,
 *   stdio?: import("node:child_process").StdioOptions,
 *   cwd?: string,
 * }} [options]
 */
export function spawnLowPriority(
  argv,
  { env = process.env, platform = process.platform, ionice, stdio = "inherit", ...rest } = {},
) {
  const enabled = lowPriorityEnabled({ env, platform });
  const hasIonice = ionice ?? (enabled && findExecutable("ionice", { env, platform }) !== null);
  const spec = enabled
    ? lowPrioritySpawnSpec(argv, { platform, hasIonice })
    : { command: argv[0], args: argv.slice(1) };
  return spawnSync(spec.command, spec.args, {
    ...rest,
    stdio,
    env: enabled ? { ...env, [LOW_PRIORITY_ENV]: "1" } : env,
  });
}

/** The shell exit code for a spawnSync result: the code, or 128+signal. */
export function exitCodeFor(result) {
  if (result.status !== null && result.status !== undefined) return result.status;
  const signal = result.signal ? os.constants.signals[result.signal] : undefined;
  return signal ? 128 + signal : 1;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    console.error("usage: node scripts/low-priority.mjs <command> [args...]");
    return 2;
  }
  const result = spawnLowPriority(argv, {});
  if (result.error) {
    console.error(`low-priority: could not start ${argv[0]} — ${result.error.message}`);
    return 1;
  }
  return exitCodeFor(result);
}

if (import.meta.main) {
  process.exit(main());
}
