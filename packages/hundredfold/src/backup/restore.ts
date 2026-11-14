import fs from "node:fs";
import path from "node:path";
import { ARCHIVE_INCLUDES, extractHomeArchive } from "./archive.js";
import { codecForId } from "./codec.js";
import { readManifest, verifyManifest, type BackupManifest } from "./manifest.js";
import { REGISTRY_DB_FILE } from "./snapshot.js";

/**
 * The registry and the sidecars SQLite writes beside it.
 *
 * A snapshot carries only the checkpointed database, so a `-wal` or `-shm` left
 * by whoever held the home before is read as the tail of whatever database
 * turns up next - and a registry left behind by a snapshot that carries none is
 * the previous occupant's sessions wearing the restored instance's name.
 */
const REGISTRY_FILES = [REGISTRY_DB_FILE, `${REGISTRY_DB_FILE}-wal`, `${REGISTRY_DB_FILE}-shm`];

export interface RestoreOptions {
  snapshot: string;
  home: string;
  /** Required to write into a home that already has something in it. */
  force?: boolean;
}

export interface RestoreResult {
  home: string;
  manifest: BackupManifest;
  restoredRegistry: boolean;
}

function assertHomeIsWritable(home: string, force: boolean): void {
  if (!fs.existsSync(home)) return;
  if (fs.existsSync(path.join(home, "gateway.json"))) {
    throw new Error(`${home} looks like a running instance - stop it before restoring into it`);
  }
  if (fs.readdirSync(home).length > 0 && !force) {
    throw new Error(`${home} is not empty - pass --force to restore over it`);
  }
}

/**
 * Rebuilds a home from a snapshot.
 *
 * The manifest is verified before anything is extracted, so a corrupt or
 * truncated archive is refused while the target home is still untouched. A
 * restore that discovers the damage halfway through has already destroyed the
 * thing it was asked to replace.
 */
export async function restoreSnapshot(options: RestoreOptions): Promise<RestoreResult> {
  const manifest = readManifest(options.snapshot);
  const problems = verifyManifest(options.snapshot, manifest);
  if (problems.length > 0) {
    throw new Error(`refusing to restore a snapshot that failed verification - ${problems.join("; ")}`);
  }

  assertHomeIsWritable(options.home, options.force === true);
  fs.mkdirSync(options.home, { recursive: true, mode: 0o700 });

  const archiveName = manifest.files.find((file) => file.path.startsWith("home."))?.path;
  if (!archiveName) throw new Error("snapshot manifest names no home archive");

  // tar overwrites what it carries but removes nothing, so restoring over a
  // populated home would leave files the snapshot does not have and produce a
  // merge of two states. Everything this command restores is cleared first -
  // the archive's own entries, and the registry it writes by hand afterwards;
  // anything outside that - workflows/, plugins/, the rest of sessions/ - is
  // not this command's to delete.
  for (const entry of ARCHIVE_INCLUDES) {
    fs.rmSync(path.join(options.home, entry), { recursive: true, force: true });
  }
  for (const name of REGISTRY_FILES) {
    fs.rmSync(path.join(options.home, "sessions", name), { force: true });
  }
  await extractHomeArchive(path.join(options.snapshot, archiveName), options.home, codecForId(manifest.codec));

  const registry = manifest.files.find((file) => file.path === REGISTRY_DB_FILE);
  if (registry) {
    const destination = path.join(options.home, "sessions", REGISTRY_DB_FILE);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(options.snapshot, registry.path), destination);
    fs.chmodSync(destination, 0o600);
  }
  return { home: options.home, manifest, restoredRegistry: registry !== undefined };
}
