import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A machine-wide budget of test cores, shared by every session on the machine.
 *
 * Every worktree, agent and human runs `pnpm test` on the same build host. A cap
 * per run does not bound the machine: three sessions at eight workers each is
 * twenty-four. So the cap is global. A run leases the cores it will use from one
 * pool before vitest starts, holds the lease for the life of the suite, and gives
 * it back when the suite ends or the process dies.
 *
 *   - The pool is the machine's cores minus RESERVED_CORES (12) kept back for the
 *     gateway, editors and people, never below MIN_POOL (8) so a small machine can
 *     still run a suite, and never above the cores it has. A 64-core host leases
 *     out 52; a 16-core one, 8.
 *   - One run takes at most DEFAULT_RUN_CORES (8), so one session alone cannot
 *     hold the whole pool, and several can run side by side.
 *   - A run takes what is free, down to MIN_GRANT. Below that it waits, because a
 *     one-worker suite that holds a lease for ten minutes is worse for everyone
 *     than a short wait.
 *
 * Leases are small JSON files under one directory in the OS temp dir, written
 * while holding a mkdir lock so two runs cannot both read the same free count. A
 * lease whose pid is dead, or that has outlived any plausible suite, is reclaimed.
 * CI runs one suite per container, so coreBudget() is empty there and nothing is leased.
 *
 * Priority (scripts/low-priority.mjs) and this budget are different levers and
 * both stay: nice 19 makes a run yield to whatever else wants the CPU, the budget
 * bounds how much memory and how many ports all the runs hold at once.
 *
 * JINN_TEST_GLOBAL_CORES=0 disables the budget; JINN_TEST_RUN_CORES sets the
 * per-run ceiling; JINN_TEST_RESERVED_CORES the cores held back.
 */

export const RESERVED_CORES = 12;
export const MIN_POOL = 8;
export const DEFAULT_RUN_CORES = 8;
export const MIN_GRANT = 2;
const POLL_MS = 2_000;
const WAIT_LOG_EVERY_MS = 30_000;
const STALE_AFTER_MS = 3 * 60 * 60 * 1000;
const LOCK_STALE_MS = 10_000;
const LOCK_SPIN_MS = 25;

function positiveInt(raw, fallback, { allowZero = false } = {}) {
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0 || (parsed === 0 && !allowZero)) return fallback;
  return parsed;
}

/**
 * The pool size for a machine with `cpus` cores: everything but the reserve,
 * floored at MIN_POOL, capped at what the machine has.
 */
export function poolSize(cpus, reserved = RESERVED_CORES) {
  return Math.min(cpus, Math.max(MIN_POOL, cpus - reserved));
}

/**
 * The budget for this environment. `global` of 0 means "no budget". JINN_TEST_GLOBAL_CORES
 * pins the pool outright (0 disables it); JINN_TEST_RESERVED_CORES changes the reserve.
 * Either way the pool never exceeds the machine's core count.
 */
export function coreBudget(env = process.env, cpus = os.availableParallelism()) {
  if (env.CI) return { global: 0, perRun: 0 };
  const pinned = positiveInt(env.JINN_TEST_GLOBAL_CORES, undefined, { allowZero: true });
  if (pinned === 0) return { global: 0, perRun: 0 };
  const reserved = positiveInt(env.JINN_TEST_RESERVED_CORES, RESERVED_CORES, { allowZero: true });
  const global = Math.max(1, Math.min(pinned ?? poolSize(cpus, reserved), cpus));
  const perRun = Math.max(1, Math.min(positiveInt(env.JINN_TEST_RUN_CORES, DEFAULT_RUN_CORES), global));
  return { global, perRun };
}

export function defaultLeaseDir() {
  return path.join(os.tmpdir(), "jinn-test-cores");
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists but belongs to someone else — still alive.
    return /** @type {NodeJS.ErrnoException} */ (error).code === "EPERM";
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Removes the lock directory if its owner has evidently died. */
function breakStaleLock(lockDir, now) {
  try {
    if (now() - fs.statSync(lockDir).mtimeMs > LOCK_STALE_MS) fs.rmdirSync(lockDir);
  } catch {
    // Released between the stat and the rmdir; the caller just tries again.
  }
}

/** Runs `fn` holding the directory's mkdir lock; a lock left by a dead run is broken. */
function withLock(dir, fn, now = () => Date.now()) {
  const lockDir = path.join(dir, "lock");
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EEXIST") throw error;
      breakStaleLock(lockDir, now);
      sleepSync(LOCK_SPIN_MS);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

/** The live leases in `dir`, deleting any that are stale. Call under the lock. */
export function liveLeases(dir, now = Date.now()) {
  const live = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith("lease-")) continue;
    const leasePath = path.join(dir, name);
    try {
      const stat = fs.statSync(leasePath);
      const lease = JSON.parse(fs.readFileSync(leasePath, "utf8"));
      const stale = now - stat.mtimeMs > STALE_AFTER_MS || !pidAlive(lease.pid);
      if (stale || !Number.isInteger(lease.cores) || lease.cores < 1) {
        fs.rmSync(leasePath, { force: true });
      } else {
        live.push({ path: leasePath, pid: lease.pid, cores: lease.cores });
      }
    } catch {
      // Unreadable or unparseable: written by nothing we trust, so reclaim it.
      fs.rmSync(leasePath, { force: true });
    }
  }
  return live;
}

/** How many cores a run asking for `perRun` would be granted given `free`; 0 means wait. */
export function grantFor({ free, perRun, global }) {
  const minimum = Math.min(MIN_GRANT, global);
  if (free < minimum) return 0;
  return Math.min(perRun, free);
}

/** One acquisition pass: a lease for however many cores are free, or null. */
export function tryAcquireCores({ dir, budget, pid, now = Date.now() }) {
  fs.mkdirSync(dir, { recursive: true });
  return withLock(dir, () => {
    const used = liveLeases(dir, now).reduce((sum, lease) => sum + lease.cores, 0);
    const cores = grantFor({ free: budget.global - used, perRun: budget.perRun, global: budget.global });
    if (cores === 0) return null;
    const leasePath = path.join(dir, `lease-${pid}-${Math.random().toString(36).slice(2, 10)}`);
    fs.writeFileSync(leasePath, JSON.stringify({ pid, cores }), { flag: "wx" });
    return { leasePath, cores };
  });
}

/**
 * Block until cores are free, then hold them for the life of the process.
 * Returns `{ cores, release }`; release also runs on exit/SIGINT/SIGTERM, and the
 * pid check reclaims the lease of a SIGKILLed run.
 */
export function acquireTestCores({
  dir = defaultLeaseDir(),
  budget = coreBudget(),
  pid = process.pid,
  log = (message) => console.log(message),
} = {}) {
  if (budget.global === 0) return { cores: null, release: () => {} };

  let lease = tryAcquireCores({ dir, budget, pid });
  let waitedMs = 0;
  while (lease === null) {
    if (waitedMs % WAIT_LOG_EVERY_MS === 0) {
      log(
        `test-core-budget: all ${budget.global} machine test cores are leased; waiting so concurrent suites don't starve each other (JINN_TEST_GLOBAL_CORES=0 disables this).`,
      );
    }
    sleepSync(POLL_MS);
    waitedMs += POLL_MS;
    lease = tryAcquireCores({ dir, budget, pid });
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    fs.rmSync(lease.leasePath, { force: true });
  };
  process.once("exit", release);
  process.once("SIGINT", () => {
    release();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    release();
    process.exit(143);
  });
  return { cores: lease.cores, release };
}
