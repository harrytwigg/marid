import fs from "node:fs";
import path from "node:path";
import { LEGACY_CODENAME, NAMES, type Names } from "../shared/codename.js";

/**
 * Snapshots are kept outside every home, in `~/Backups/<codename>-homes/<instance>/<date>`. A rename of
 * the codename changes both the root and the instance directory, and a snapshot left under the old names
 * would be neither pruned nor found by the instance's own listing, so the snapshots move with the home.
 */

/** The directory snapshots are written under, named for the codename. */
export function backupRootFor(homeDir: string, names: Names = NAMES): string {
  return path.join(homeDir, "Backups", `${names.codename}-homes`);
}

/** The root an earlier codename used. */
export function legacyBackupRootFor(homeDir: string): string {
  return path.join(homeDir, "Backups", `${LEGACY_CODENAME}-homes`);
}

function isRealDirectory(target: string): boolean {
  try {
    return fs.lstatSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** Bring each snapshot date of `source` into `target`, keeping any date `target` already has. */
function mergeSnapshotDirs(source: string, target: string): void {
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(source)) {
    const destination = path.join(target, entry);
    if (!fs.existsSync(destination)) fs.renameSync(path.join(source, entry), destination);
  }
  try {
    fs.rmdirSync(source);
  } catch { /* a date the target already had is left where it was */ }
}

/**
 * Move one instance's snapshots to the current root under its current name: those under the old root
 * (`jinn-homes/jinn-x`) and those a current-named run wrote under the old instance name
 * (`<codename>-homes/jinn-x`). Returns how many directories it moved. The old root is removed once empty.
 */
export function renameBackupDirs(move: { homeDir: string; legacyName: string; currentName: string; names?: Names }): number {
  const names = move.names ?? NAMES;
  const currentRoot = backupRootFor(move.homeDir, names);
  const legacyRoot = legacyBackupRootFor(move.homeDir);
  const target = path.join(currentRoot, move.currentName);
  const sources = [
    path.join(legacyRoot, move.legacyName),
    path.join(legacyRoot, move.currentName),
    path.join(currentRoot, move.legacyName),
  ].filter((source) => source !== target && isRealDirectory(source));
  for (const source of sources) mergeSnapshotDirs(source, target);
  if (legacyRoot !== currentRoot) {
    try {
      fs.rmdirSync(legacyRoot);
    } catch { /* other instances' snapshots are still in it */ }
  }
  return sources.length;
}
