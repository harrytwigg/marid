import fs from "node:fs";
import path from "node:path";

/**
 * A lock for moving a home, held beside it. `wx` makes creating it atomic, so of two processes that start
 * at once only one moves the directory; the other waits for the move to finish and then finds it done.
 * A lock whose process has died is stale and is taken over.
 */

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function lockIsStale(lockFile: string): boolean {
  try {
    const pid = Number.parseInt(fs.readFileSync(lockFile, "utf-8").trim(), 10);
    return !Number.isSafeInteger(pid) || pid <= 0 || !processAlive(pid);
  } catch {
    return true;
  }
}

export interface HomeLock {
  release(): void;
}

/**
 * Clear a lock that looked stale. Two processes can both see it stale; removing it by name would let the second
 * one delete the lock the first had just taken. The file is moved aside first and looked at again there: if what
 * was moved is a live process's lock after all, it goes back and the caller does not take the lock.
 */
function takeOverStaleLock(lockFile: string): boolean {
  const aside = `${lockFile}.stale-${process.pid}-${Date.now()}`;
  try {
    fs.renameSync(lockFile, aside);
  } catch {
    return true; // already gone: someone else cleared it, and the next attempt will see who holds it now
  }
  if (lockIsStale(aside)) {
    fs.rmSync(aside, { force: true });
    return true;
  }
  try {
    fs.linkSync(aside, lockFile);
  } catch { /* a newer lock has been taken meanwhile; the live one it replaced is no longer needed */ }
  fs.rmSync(aside, { force: true });
  return false;
}

/** Try to take the lock once. Undefined when another live process holds it. */
export function tryAcquireHomeLock(lockFile: string): HomeLock | undefined {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(lockFile, String(process.pid), { flag: "wx", mode: 0o600 });
      return { release: () => { try { fs.rmSync(lockFile, { force: true }); } catch { /* best effort */ } } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!lockIsStale(lockFile)) return undefined;
      if (!takeOverStaleLock(lockFile)) return undefined;
    }
  }
  return undefined;
}

/** Take the lock, waiting up to `timeoutMs` for another process to finish. Undefined when it never frees. */
export async function acquireHomeLock(lockFile: string, timeoutMs = 60_000, pollMs = 200): Promise<HomeLock | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lock = tryAcquireHomeLock(lockFile);
    if (lock) return lock;
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
