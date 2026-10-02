import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALLOW_NETWORK_FS_ENV,
  assertLocalDatabasePath,
  assertNotRemoteStagedHome,
  isRemoteStagedHome,
  networkFilesystemOf,
} from "../local-db-guard.js";
import { REMOTE_STAGE_MARKER } from "../remote-farm.js";
import { preflightWorkItemsDatabase } from "../../work-items/migrate.js";

const FUSE = 0x65735546;
const EXT4 = 0xef53;

describe("local-db-guard", () => {
  let dir: string;
  let local: string;
  let mount: string;

  /** A statfs that reports everything under `mount` as FUSE, like sshfs. */
  const statfs = (p: string) => ({ type: p === mount || p.startsWith(`${mount}${path.sep}`) ? FUSE : EXT4 });
  const linux = { platform: "linux" as const, env: {}, statfs };

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "db-guard-")));
    local = path.join(dir, "local");
    mount = path.join(dir, "mount");
    fs.mkdirSync(path.join(local, "sessions"), { recursive: true });
    fs.mkdirSync(path.join(mount, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(mount, "sessions", "registry.db"), "");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("allows a database on a local filesystem, present or not yet created", () => {
    expect(() => assertLocalDatabasePath(path.join(local, "sessions", "registry.db"), linux)).not.toThrow();
    expect(() => assertLocalDatabasePath(path.join(local, "new", "deeper", "registry.db"), linux)).not.toThrow();
  });

  it("refuses a database on a FUSE mount, naming the filesystem", () => {
    expect(() => assertLocalDatabasePath(path.join(mount, "sessions", "registry.db"), linux))
      .toThrow(/fuse .*filesystem/);
  });

  it("refuses a database that does not exist yet when its directory is on the mount", () => {
    expect(() => assertLocalDatabasePath(path.join(mount, "sessions", "nope", "x.db"), linux)).toThrow(/fuse/);
  });

  it("judges a symlinked database by its target, so a local link cannot smuggle a FUSE file past it", () => {
    const link = path.join(local, "sessions", "registry.db");
    fs.symlinkSync(path.join(mount, "sessions", "registry.db"), link);
    expect(() => assertLocalDatabasePath(link, linux)).toThrow(/fuse/);
  });

  it("follows a dangling symlink and a chain of links to where SQLite would create the file", () => {
    const dangling = path.join(local, "sessions", "dangling.db");
    fs.symlinkSync(path.join(mount, "sessions", "missing.db"), dangling);
    expect(() => assertLocalDatabasePath(dangling, linux)).toThrow(/fuse/);

    const mid = path.join(local, "sessions", "mid");
    fs.symlinkSync(path.join(mount, "sessions", "registry.db"), mid);
    const chained = path.join(local, "sessions", "chained.db");
    fs.symlinkSync("mid", chained);
    expect(() => assertLocalDatabasePath(chained, linux)).toThrow(/fuse/);
  });

  it("judges a symlinked directory by its target", () => {
    const linkedDir = path.join(local, "linked-sessions");
    fs.symlinkSync(path.join(mount, "sessions"), linkedDir);
    expect(() => assertLocalDatabasePath(path.join(linkedDir, "registry.db"), linux)).toThrow(/fuse/);
  });

  it("fails closed when the filesystem cannot be determined", () => {
    const broken = { ...linux, statfs: () => { throw new Error("EACCES"); } };
    expect(() => assertLocalDatabasePath(path.join(local, "sessions", "registry.db"), broken))
      .toThrow(/could not determine which filesystem.*EACCES/);
  });

  it("refuses a symlink loop rather than spinning", () => {
    const a = path.join(local, "a.db");
    const b = path.join(local, "b.db");
    fs.symlinkSync(b, a);
    fs.symlinkSync(a, b);
    expect(() => assertLocalDatabasePath(a, linux)).toThrow(/too many symbolic links/);
  });

  it("reports nfs, smb and 9p as network filesystems too", () => {
    for (const [type, name] of [[0x6969, "nfs"], [0xfe534d42, "smb2"], [0x01021997, "9p"]] as const) {
      expect(networkFilesystemOf(path.join(local, "x.db"), { statfs: () => ({ type }) })).toMatch(name);
    }
  });

  it("accepts a bigint f_type", () => {
    expect(networkFilesystemOf(path.join(local, "x.db"), { statfs: () => ({ type: BigInt(FUSE) }) })).toMatch(/fuse/);
  });

  it("is Linux-only: other platforms report filesystem types differently, so it does not guess", () => {
    expect(() => assertLocalDatabasePath(path.join(mount, "sessions", "registry.db"), { ...linux, platform: "darwin" }))
      .not.toThrow();
  });

  it(`can be overridden with ${ALLOW_NETWORK_FS_ENV}=1`, () => {
    const env = { [ALLOW_NETWORK_FS_ENV]: "1" };
    expect(() => assertLocalDatabasePath(path.join(mount, "sessions", "registry.db"), { ...linux, env })).not.toThrow();
  });

  it("refuses a directory at the database path, which is what a staged home keeps there", () => {
    const sentinel = path.join(local, "sessions", "registry.db");
    fs.mkdirSync(sentinel);
    expect(() => assertLocalDatabasePath(sentinel, linux)).toThrow(/is a directory, not a database/);
  });

  it("refuses any database in a remote session's staged home, even a local one", () => {
    fs.writeFileSync(path.join(local, REMOTE_STAGE_MARKER), "stage\n");
    expect(isRemoteStagedHome(local)).toBe(true);
    expect(() => assertLocalDatabasePath(path.join(local, "sessions", "registry.db"), { ...linux, home: local }))
      .toThrow(/remote session's staged home/);
    expect(() => assertNotRemoteStagedHome(local, "start the gateway")).toThrow(/Refusing to start the gateway/);
  });

  it("does not take a symlinked marker as a staged home (the farm writes a real file)", () => {
    fs.writeFileSync(path.join(dir, "elsewhere"), "x");
    fs.symlinkSync(path.join(dir, "elsewhere"), path.join(local, REMOTE_STAGE_MARKER));
    expect(isRemoteStagedHome(local)).toBe(false);
  });

  describe("preflightWorkItemsDatabase", () => {
    it("refuses a FUSE database before opening it: no -shm or -wal is created", () => {
      // A real WAL database, closed cleanly so its sidecars are gone.
      const file = path.join(local, "sessions", "registry.db");
      const db = new Database(file);
      db.pragma("journal_mode = WAL");
      db.exec("create table t(x)");
      db.close();
      expect(fs.existsSync(`${file}-shm`)).toBe(false);

      // Report its directory as sshfs, as the remote host sees the gateway home.
      const real = fs.statfsSync;
      vi.spyOn(fs, "statfsSync").mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
        const out = (real as (p: fs.PathLike, ...r: unknown[]) => fs.StatsFs)(p, ...rest);
        return String(p).startsWith(local) ? { ...out, type: FUSE } : out;
      }) as typeof fs.statfsSync);

      if (process.platform === "linux") {
        expect(() => preflightWorkItemsDatabase(file)).toThrow(/fuse/);
        // The open itself is what truncates and rebuilds the live wal-index, and
        // even a read-only open creates -shm. None happened.
        expect(fs.existsSync(`${file}-shm`)).toBe(false);
        expect(fs.existsSync(`${file}-wal`)).toBe(false);
      }

      // Control: the same file on a local filesystem is opened (and -shm appears).
      vi.restoreAllMocks();
      preflightWorkItemsDatabase(file);
      expect(fs.existsSync(`${file}-shm`)).toBe(true);
    });

    it("names a staged home's directory sentinel instead of calling it corruption", () => {
      const sentinel = path.join(local, "sessions", "registry.db");
      fs.mkdirSync(sentinel);
      expect(() => preflightWorkItemsDatabase(sentinel)).toThrow(/is a directory, not a database/);
    });
  });
});
