import fs from "node:fs";
import path from "node:path";
import { SNAPSHOT_DIR_PATTERN } from "./snapshot.js";

export interface PruneOptions {
  root: string;
  now: Date;
  retentionDays: number;
  /** Oldest snapshots are dropped past this, across every instance together. */
  maxTotalBytes?: number;
}

export interface PruneResult {
  removed: string[];
  /** Dated entries that were not plain directories, so were left untouched. */
  skipped: string[];
  keptBytes: number;
  /** The cap is still exceeded by the snapshots nothing is allowed to delete. */
  overCap: boolean;
}

interface Snapshot {
  instance: string;
  date: string;
  directory: string;
  bytes: number;
}

const DAY_MS = 86_400_000;

function directorySize(directory: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) total += directorySize(target);
    else if (entry.isFile()) total += fs.statSync(target).size;
  }
  return total;
}

function listInstanceDirectories(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/**
 * A dated name is not enough to earn deletion: a symlink is followed by nothing
 * here, because `rm -r` through one would delete whatever it points at, which by
 * definition is not inside the backup root.
 */
function collect(root: string, skipped: string[]): Snapshot[] {
  const snapshots: Snapshot[] = [];
  for (const instance of listInstanceDirectories(root)) {
    const instanceRoot = path.join(root, instance);
    for (const entry of fs.readdirSync(instanceRoot, { withFileTypes: true })) {
      if (!SNAPSHOT_DIR_PATTERN.test(entry.name)) continue;
      const directory = path.join(instanceRoot, entry.name);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        skipped.push(directory);
        continue;
      }
      if (Number.isNaN(Date.parse(`${entry.name}T00:00:00.000Z`))) continue;
      snapshots.push({ instance, date: entry.name, directory, bytes: directorySize(directory) });
    }
  }
  return snapshots;
}

/** The newest snapshot per instance is the one that makes the backup a backup. */
function newestPerInstance(snapshots: Snapshot[]): Set<string> {
  const newest = new Map<string, Snapshot>();
  for (const snapshot of snapshots) {
    const held = newest.get(snapshot.instance);
    if (!held || snapshot.date > held.date) newest.set(snapshot.instance, snapshot);
  }
  return new Set([...newest.values()].map((snapshot) => snapshot.directory));
}

/**
 * Prunes the backup root to a rolling window and a total-size cap. It runs on
 * every backup, including one where a target failed - a run that cannot write
 * is exactly when an unbounded pile of old snapshots would fill the disk.
 *
 * The cap never fails the run: it removes what it is allowed to remove and
 * reports the shortfall.
 */
export function pruneSnapshots(options: PruneOptions): PruneResult {
  const result: PruneResult = { removed: [], skipped: [], keptBytes: 0, overCap: false };
  if (!fs.existsSync(options.root)) return result;

  const snapshots = collect(options.root, result.skipped);
  const protectedDirs = newestPerInstance(snapshots);
  // Compared as calendar dates, not instants: a snapshot name carries no time,
  // so an instant cutoff would make "14 days" mean 14 days plus whatever hour
  // the job happens to run at, and quietly drop the oldest day in the window.
  const cutoff = new Date(options.now.getTime() - options.retentionDays * DAY_MS).toISOString().slice(0, 10);

  const remove = (snapshot: Snapshot): void => {
    fs.rmSync(snapshot.directory, { recursive: true, force: true });
    result.removed.push(snapshot.directory);
  };

  const kept: Snapshot[] = [];
  for (const snapshot of snapshots) {
    const expired = snapshot.date < cutoff;
    if (expired && !protectedDirs.has(snapshot.directory)) remove(snapshot);
    else kept.push(snapshot);
  }

  let total = kept.reduce((sum, snapshot) => sum + snapshot.bytes, 0);
  if (options.maxTotalBytes !== undefined && total > options.maxTotalBytes) {
    const oldestFirst = [...kept].sort((a, b) => a.date.localeCompare(b.date));
    for (const snapshot of oldestFirst) {
      if (total <= options.maxTotalBytes) break;
      if (protectedDirs.has(snapshot.directory)) continue;
      remove(snapshot);
      kept.splice(kept.indexOf(snapshot), 1);
      total -= snapshot.bytes;
    }
    result.overCap = total > options.maxTotalBytes;
  }
  result.keptBytes = total;
  return result;
}
