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
      fs.rmSync(lockFile, { force: true });
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
