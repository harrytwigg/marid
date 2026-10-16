import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readManifest, verifyManifest } from "../backup/manifest.js";
import { restoreSnapshot } from "../backup/restore.js";
import { runBackupRun, DEFAULT_MAX_TOTAL_BYTES, DEFAULT_RETENTION_DAYS } from "../backup/run.js";
import { SNAPSHOT_DIR_PATTERN } from "../backup/snapshot.js";
import { backupRootFor, legacyBackupRootFor } from "../instances/backup-rename.js";

type JsonOptions = { json?: boolean };

/** Outside every instance home by design: a backup inside the thing it backs up
 *  is lost with it. */
export function defaultBackupRoot(homeDir: string = os.homedir()): string {
  return backupRootFor(homeDir);
}

const GIB = 1024 * 1024 * 1024;

function positiveInteger(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive whole number`);
  return parsed;
}

const printJson = (result: unknown): void => console.log(JSON.stringify(result, null, 2));

function fail(error: unknown): void {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

const megabytes = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function reportRun(result: Awaited<ReturnType<typeof runBackupRun>>): void {
  for (const target of result.targets) {
    const detail = target.status === "ok" ? megabytes(target.bytes) : target.error ?? "failed";
    console.log(`${target.status === "ok" ? "ok" : "FAILED"}  ${target.name}  ${detail}`);
  }
  const { removed, keptBytes, overCap } = result.retention;
  console.log(`retention: removed ${removed.length}, keeping ${megabytes(keptBytes)} in ${result.root}`);
  if (overCap) console.log("retention: still above the size cap - every remaining snapshot is the newest of its home");
}

export async function runBackup(
  options: { root?: string; retentionDays?: string; maxTotalGb?: string } & JsonOptions = {},
): Promise<void> {
  try {
    const result = await runBackupRun({
      root: options.root ?? defaultBackupRoot(),
      now: new Date(),
      retentionDays: positiveInteger(options.retentionDays, DEFAULT_RETENTION_DAYS, "--retention-days"),
      maxTotalBytes: positiveInteger(options.maxTotalGb, DEFAULT_MAX_TOTAL_BYTES / GIB, "--max-total-gb") * GIB,
    });
    if (options.json) printJson(result);
    else reportRun(result);
    if (result.status === "failed") process.exitCode = 1;
  } catch (error) {
    fail(error);
  }
}

interface SnapshotListing {
  instance: string;
  date: string;
  path: string;
  bytes: number;
  codec: string;
}

function listSnapshots(root: string): SnapshotListing[] {
  if (!fs.existsSync(root)) return [];
  const listings: SnapshotListing[] = [];
  for (const instance of fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    const instanceRoot = path.join(root, instance.name);
    for (const entry of fs.readdirSync(instanceRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !SNAPSHOT_DIR_PATTERN.test(entry.name)) continue;
      const directory = path.join(instanceRoot, entry.name);
      try {
        const manifest = readManifest(directory);
        listings.push({
          instance: instance.name,
          date: entry.name,
          path: directory,
          bytes: manifest.files.reduce((total, file) => total + file.bytes, 0),
          codec: manifest.codec,
        });
      } catch { /* a directory without a readable manifest is not a snapshot */ }
    }
  }
  return listings.sort((a, b) => a.instance.localeCompare(b.instance) || a.date.localeCompare(b.date));
}

export function runBackupList(options: { root?: string } & JsonOptions = {}): void {
  // Without an explicit root, the snapshots an earlier codename wrote (an instance not yet moved still has them there) are listed too.
  const roots = options.root ? [options.root] : [...new Set([defaultBackupRoot(), legacyBackupRootFor(os.homedir())])];
  const snapshots = roots.flatMap(listSnapshots);
  if (options.json) return printJson(snapshots);
  if (snapshots.length === 0) return console.log("No snapshots yet.");
  for (const snapshot of snapshots) {
    console.log(`${snapshot.instance}  ${snapshot.date}  ${megabytes(snapshot.bytes)}  ${snapshot.codec}`);
  }
}

export function runBackupVerify(snapshot: string, options: JsonOptions = {}): void {
  try {
    const manifest = readManifest(snapshot);
    const problems = verifyManifest(snapshot, manifest);
    if (options.json) printJson({ snapshot, ok: problems.length === 0, problems });
    else console.log(problems.length === 0 ? `ok  ${snapshot}` : `FAILED  ${snapshot}\n  ${problems.join("\n  ")}`);
    if (problems.length > 0) process.exitCode = 1;
  } catch (error) {
    fail(error);
  }
}

export async function runBackupRestore(
  snapshot: string,
  options: { home?: string; force?: boolean } & JsonOptions = {},
): Promise<void> {
  try {
    if (!options.home) throw new Error("--home is required: name the directory to rebuild");
    const result = await restoreSnapshot({ snapshot, home: options.home, force: options.force });
    if (options.json) printJson({ home: result.home, instance: result.manifest.instance, restoredRegistry: result.restoredRegistry });
    else console.log(`Restored ${result.manifest.instance} (${result.manifest.createdAt}) into ${result.home}`);
  } catch (error) {
    fail(error);
  }
}
