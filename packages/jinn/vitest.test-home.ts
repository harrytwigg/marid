import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROD_HOME = path.join(os.homedir(), '.jinn');
// Global setup redirects the workers' generic temp variables beneath JINN_HOME.
// Keep the pre-redirect OS root for the safety check so JINN_HOME remains a
// valid child of the real temp directory inside every worker.
const TEMP_ROOT = process.env.JINN_VITEST_SYSTEM_TEMP_ROOT ?? os.tmpdir();

/** Resolve symlinks in the existing prefix while preserving a missing tail. */
export function canonicalPath(pathname: string): string {
  let cursor = path.resolve(pathname);
  const missing: string[] = [];

  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }

  let canonicalPrefix = cursor;
  try {
    canonicalPrefix = fs.realpathSync.native(cursor);
  } catch {
    // `path.resolve` is still deterministic if the existing prefix disappears
    // between existsSync and realpathSync.
  }

  return path.join(canonicalPrefix, ...missing);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

export function isTempPath(pathname: string): boolean {
  return isWithin(canonicalPath(TEMP_ROOT), canonicalPath(pathname));
}

/** Fail closed when a Vitest worker did not inherit an isolated home. */
export function assertIsolatedTestHome(home: string | undefined): string {
  if (!home) {
    throw new Error('refusing to run tests with an unset JINN_HOME');
  }

  const canonicalHome = canonicalPath(home);
  if (canonicalHome === canonicalPath(PROD_HOME)) {
    throw new Error('refusing to run tests against prod JINN_HOME=~/.jinn');
  }
  if (!isTempPath(canonicalHome)) {
    throw new Error(`refusing to run tests against non-temp JINN_HOME=${home}`);
  }

  return canonicalHome;
}

/**
 * Fail closed unless Claude Code's config dir is a temp directory of the run's own.
 *
 * `CLAUDE_CONFIG_DIR` (else `~/.claude`) holds the operator's credentials and every
 * transcript Claude Code has written, so a test that cleans a fixture under it
 * would otherwise clean the real one. A temp path that is still the real home's
 * `.claude*` (a temp root inside the home) is refused as well.
 */
export function assertIsolatedClaudeConfigDir(dir: string | undefined): string {
  if (!dir) {
    throw new Error('refusing to run tests with an unset CLAUDE_CONFIG_DIR');
  }

  const canonicalDir = canonicalPath(dir);
  const realHome = canonicalPath(os.homedir());
  const [topLevel] = path.relative(realHome, canonicalDir).split(path.sep);
  if (isWithin(realHome, canonicalDir) && topLevel.startsWith('.claude')) {
    throw new Error(`refusing to run tests against the real Claude config dir CLAUDE_CONFIG_DIR=${dir}`);
  }
  if (!isTempPath(canonicalDir)) {
    throw new Error(`refusing to run tests against non-temp CLAUDE_CONFIG_DIR=${dir}`);
  }

  return canonicalDir;
}

/**
 * Establish one safe home for the Vitest run. Existing temp homes are accepted
 * for focused/CI runs; unset, production, and other non-temp homes are replaced.
 */
export function ensureIsolatedTestHome(
  env: NodeJS.ProcessEnv = process.env,
): { home: string; created: boolean } {
  const configuredHome = env.JINN_HOME;
  if (configuredHome) {
    try {
      assertIsolatedTestHome(configuredHome);
      const home = path.resolve(configuredHome);
      env.JINN_HOME = home;
      return { home, created: false };
    } catch {
      // Unsafe launch environments are redirected below, then asserted again.
    }
  }

  const home = fs.mkdtempSync(path.join(TEMP_ROOT, 'jinn-vitest-'));
  env.JINN_HOME = home;
  assertIsolatedTestHome(env.JINN_HOME);
  return { home, created: true };
}

/**
 * Give one test FILE its own home, before its static imports freeze paths.ts.
 *
 * The run-level home above is safe but shared: `pool: 'forks'` gives each file a
 * fresh process, not a fresh home, so two files that don't override JINN_HOME
 * resolve the same `sessions/registry.db` and write it from parallel forks —
 * the intermittent "database is locked" that chased per file. setupFiles
 * run inside each worker before its test module is evaluated, so calling this
 * there allocates the home once per file and no file has to remember to.
 *
 * The home is created beneath the run's temp root, so global teardown removes
 * it with the rest of the run; TMPDIR/TMP/TEMP are repointed inside it so
 * fixture scratch dirs stay in the same cleanup-owned subtree.
 *
 * `CLAUDE_CONFIG_DIR` gets the same treatment, whatever the launch environment
 * set it to: a directory beside the home, so transcripts, skills and
 * `.claude.json` a test writes or removes are this file's and never the
 * operator's. It sits outside the home because a profile inside the instance
 * home is one the gateway refuses. Its `.credentials.json` holds no OAuth pair,
 * which the launch preflight reads as "cannot tell" and lets through: no test
 * depends on whether the machine running it is signed in, and none can read a
 * real token. A test about the login gives itself its own directory.
 */
export function createIsolatedTestFileHome(env: NodeJS.ProcessEnv = process.env): string {
  assertIsolatedTestHome(env.JINN_HOME);
  const root = env.TMPDIR ?? env.TEMP ?? env.TMP ?? os.tmpdir();
  assertIsolatedTestHome(root);
  // The home sits inside a directory of its own: a department's stage directory is made beside
  // the home (`<parent of home>/.jinn-departments/.instances/<basename of home>`), and two files must not share that parent.
  const base = fs.mkdtempSync(path.join(root, 'jinn-vitest-file-'));
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  const temp = path.join(home, 'tmp');
  fs.mkdirSync(temp);
  const claudeConfigDir = path.join(base, 'claude');
  fs.mkdirSync(claudeConfigDir);
  fs.writeFileSync(path.join(claudeConfigDir, '.credentials.json'), '{}\n');
  env.JINN_HOME = home;
  env.CLAUDE_CONFIG_DIR = claudeConfigDir;
  assertIsolatedClaudeConfigDir(env.CLAUDE_CONFIG_DIR);
  for (const key of ['TMPDIR', 'TMP', 'TEMP']) env[key] = temp;
  return home;
}
