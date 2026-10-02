import fs from "node:fs";
import path from "node:path";
import { REMOTE_STAGE_MARKER } from "./remote-farm.js";

/**
 * Refuse to open a Marid SQLite database that is not on a local filesystem.
 *
 * The registry runs in WAL mode. WAL needs a shared-memory index (`-shm`) and
 * POSIX locks that every process using the database can see; SQLite's own
 * documentation says it does not work over a network filesystem. Over sshfs
 * (FUSE) the failure is silent and destructive: a connection on another host
 * finds the dead-man-switch lock free, truncates the live `-shm`, rebuilds the
 * wal-index from its own view and later writes it back, so the gateway reads
 * stale page versions and corrupts its B-trees. `readonly` does not prevent
 * any of that. The check therefore runs before the first open of the file.
 *
 * Linux only: the `f_type` magics below are Linux values. Other platforms
 * report filesystem types differently (macOS numbers are not stable), so the
 * check is skipped there rather than guessed at.
 */

/** Linux statfs `f_type` magics for FUSE (sshfs among them) and network
 *  filesystems. */
export const NETWORK_FS_TYPES: ReadonlyMap<number, string> = new Map([
  [0x65735546, "fuse"],
  [0x6969, "nfs"],
  [0x517b, "smb"],
  [0xff534d42, "cifs"],
  [0xfe534d42, "smb2"],
  [0x01021997, "9p"],
  [0x00c36400, "ceph"],
  [0x5346414f, "afs"],
  [0x73757245, "coda"],
  [0x564c, "ncp"],
]);

/** Set to `1` to open a database on a network filesystem anyway, for a setup
 *  where every process using it really is on one host. Off by default. */
export const ALLOW_NETWORK_FS_ENV = "JINN_ALLOW_NETWORK_FS_DB";

export interface LocalDbGuardDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  statfs?: (p: string) => { type: number | bigint };
}

const MAX_LINK_HOPS = 40;

/**
 * The paths whose filesystem decides where `dbPath`'s bytes, `-wal` and `-shm`
 * really live: a symlink (even a dangling one) is followed to its target, then
 * the resolved file if it exists, and the resolved nearest existing directory.
 * Throws when the path cannot be resolved.
 */
function backingPaths(dbPath: string): string[] {
  let p = path.resolve(dbPath);
  for (let hops = 0; ; hops += 1) {
    let link: string | null = null;
    try {
      if (fs.lstatSync(p).isSymbolicLink()) link = fs.readlinkSync(p);
    } catch { /* missing: judged by its nearest existing ancestor */ }
    if (link === null) break;
    if (hops >= MAX_LINK_HOPS) throw new Error(`too many symbolic links at ${dbPath}`);
    p = path.resolve(path.dirname(p), link);
  }
  const out: string[] = [];
  try { out.push(fs.realpathSync.native(p)); } catch { /* not there yet */ }
  for (let dir = path.dirname(p); ; ) {
    try {
      out.push(fs.realpathSync.native(dir));
      break;
    } catch {
      const up = path.dirname(dir);
      if (up === dir) throw new Error(`no existing directory above ${dbPath}`);
      dir = up;
    }
  }
  return out;
}

/** The network filesystem `dbPath` lives on, or null when it is local.
 *  Throws when it cannot tell, so callers fail closed. */
export function networkFilesystemOf(dbPath: string, deps: LocalDbGuardDeps = {}): string | null {
  const statfs = deps.statfs ?? ((p: string) => fs.statfsSync(p));
  for (const p of backingPaths(dbPath)) {
    const name = NETWORK_FS_TYPES.get(Number(statfs(p).type));
    if (name) return `${name} (${p})`;
  }
  return null;
}

/** Whether `home` is a remote session's staged home (FARM_SCRIPT writes the
 *  marker as a real file, never a link). */
export function isRemoteStagedHome(home: string): boolean {
  try {
    return fs.lstatSync(path.join(home, REMOTE_STAGE_MARKER)).isFile();
  } catch {
    return false;
  }
}

/** Throws when `home` is a remote session's staged home: its linked entries are
 *  the gateway's live files, and `what` must only ever run on the gateway. */
export function assertNotRemoteStagedHome(home: string, what: string): void {
  if (!isRemoteStagedHome(home)) return;
  throw new Error(
    `Refusing to ${what}: JINN_HOME (${home}) is a remote session's staged home, whose entries ` +
      `lead to the gateway's live data. Run this on the gateway itself, or point JINN_HOME at ` +
      `a separate home of your own.`,
  );
}

/**
 * Throws, before anything opens `dbPath`, when:
 *  - `opts.home` is given and is a remote session's staged home;
 *  - `dbPath` is a directory (the staged home keeps one at each database name);
 *  - `dbPath` resolves onto a FUSE or network filesystem (Linux), unless
 *    {@link ALLOW_NETWORK_FS_ENV} is `1`;
 *  - the filesystem cannot be determined at all (fail closed).
 */
export function assertLocalDatabasePath(
  dbPath: string,
  opts: LocalDbGuardDeps & { home?: string } = {},
): void {
  if (opts.home !== undefined) assertNotRemoteStagedHome(opts.home, `open ${dbPath}`);
  assertNotDirectory(dbPath);
  if ((opts.platform ?? process.platform) !== "linux") return;
  if ((opts.env ?? process.env)[ALLOW_NETWORK_FS_ENV] === "1") return;
  assertLocalFilesystem(dbPath, opts);
}

function assertNotDirectory(dbPath: string): void {
  let isDir = false;
  try { isDir = fs.statSync(dbPath).isDirectory(); } catch { /* absent is fine */ }
  if (!isDir) return;
  throw new Error(
    `Refusing to open ${dbPath}: it is a directory, not a database. A remote session's staged ` +
      `home keeps a directory at each gateway database name so nothing opens the live file through ` +
      `the mount; open it on the gateway instead.`,
  );
}

function assertLocalFilesystem(dbPath: string, deps: LocalDbGuardDeps): void {
  let remote: string | null;
  try {
    remote = networkFilesystemOf(dbPath, deps);
  } catch (err) {
    throw new Error(
      `Refusing to open ${dbPath}: could not determine which filesystem it is on ` +
        `(${err instanceof Error ? err.message : String(err)}).`,
    );
  }
  if (!remote) return;
  throw new Error(
    `Refusing to open ${dbPath}: it is on a ${remote} filesystem. SQLite WAL needs locks and ` +
      `shared memory every process can see, and a remote open corrupts the live database even ` +
      `read-only. Open it on the host whose local disk holds it (set ${ALLOW_NETWORK_FS_ENV}=1 ` +
      `only if every process using it really is on one host).`,
  );
}
