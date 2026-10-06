import fs from "node:fs";

/**
 * Whether a Claude Code binary knows the `claudeMdExcludes` setting, which a
 * department-scoped session relies on to skip the instructions in the directories above
 * its stage directory (Claude Code reads them from every ancestor of its cwd). An older
 * build ignores the key silently, so a scoped session is refused on one rather than
 * started with whatever an ancestor holds. The binary is searched for the setting's name,
 * as the remote sync does with `grep`, in chunks so a native build is never read whole;
 * the answer is cached per path, size and modification time.
 */

const SETTING = Buffer.from("claudeMdExcludes");
const CHUNK = 4 * 1024 * 1024;
const cache = new Map<string, boolean>();

function search(file: string): boolean {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(CHUNK + SETTING.length);
    let carried = 0;
    for (;;) {
      const read = fs.readSync(fd, buffer, carried, CHUNK, null);
      if (read === 0) return false;
      const filled = carried + read;
      if (buffer.subarray(0, filled).includes(SETTING)) return true;
      // Keep the tail, so a name split across two chunks is still found.
      carried = Math.min(SETTING.length - 1, filled);
      buffer.copy(buffer, 0, filled - carried, filled);
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** False for a binary that cannot be found or read, as for one that predates the setting. */
export function claudeKnowsMdExcludes(bin: string): boolean {
  let real: string;
  let stat: fs.Stats;
  try {
    real = fs.realpathSync(bin);
    stat = fs.statSync(real);
  } catch {
    return false;
  }
  const key = `${real}\0${stat.size}\0${stat.mtimeMs}`;
  const known = cache.get(key);
  if (known !== undefined) return known;
  let found = false;
  try {
    found = stat.isFile() && search(real);
  } catch {
    found = false;
  }
  cache.set(key, found);
  return found;
}

type Probe = (bin: string) => boolean;
let probe: Probe | null = null;

/**
 * The check a scoped local turn runs, registered at gateway boot ({@link claudeKnowsMdExcludes}).
 * With none registered, as in a test, every binary passes, so no suite depends on which
 * Claude Code the machine running it has installed.
 */
export function setClaudeMdExcludesProbe(next: Probe | null): void {
  probe = next;
}

/** Whether a scoped local session may start with `bin`. */
export function claudeMayRunScoped(bin: string): boolean {
  return probe ? probe(bin) : true;
}

export function clearClaudeMdExcludesCacheForTests(): void {
  cache.clear();
}
