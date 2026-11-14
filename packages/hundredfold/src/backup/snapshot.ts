import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createHomeArchive } from "./archive.js";
import { resolveArchiveCodec, type ArchiveCodec } from "./codec.js";
import { describeFile, verifyManifest, writeManifest, type BackupManifest } from "./manifest.js";
import { backupSqliteDatabase } from "./sqlite-backup.js";
import type { BackupTarget } from "./targets.js";

export const REGISTRY_DB_FILE = "registry.db";

/** One target's outcome, and the shape `--json` hands the alerting job. */
export interface SnapshotReport {
  name: string;
  status: "ok" | "failed";
  bytes: number;
  path: string;
  error?: string;
}

export function snapshotDateStamp(when: Date): string {
  return when.toISOString().slice(0, 10);
}

/** A dated directory name, and nothing else, is a snapshot. */
export const SNAPSHOT_DIR_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

async function writeSnapshotInto(
  directory: string,
  target: BackupTarget,
  codec: ArchiveCodec,
  createdAt: Date,
): Promise<number> {
  const archiveName = `home.${codec.extension}`;
  const archive = await createHomeArchive(target.home, path.join(directory, archiveName), codec);

  const files = [describeFile(directory, archiveName)];
  const registrySource = path.join(target.home, "sessions", REGISTRY_DB_FILE);
  if (fs.existsSync(registrySource)) {
    await backupSqliteDatabase(registrySource, path.join(directory, REGISTRY_DB_FILE));
    files.push(describeFile(directory, REGISTRY_DB_FILE));
  }

  const manifest: BackupManifest = {
    schemaVersion: 1,
    instance: target.name,
    home: target.home,
    createdAt: createdAt.toISOString(),
    codec: codec.id,
    uncompressedBytes: archive.uncompressedBytes,
    compressedBytes: archive.compressedBytes,
    files,
  };
  writeManifest(directory, manifest);

  // Verify from disk rather than from what we just held in memory: a snapshot
  // nobody has re-read is a snapshot nobody knows restores.
  const problems = verifyManifest(directory, manifest);
  if (problems.length > 0) throw new Error(`snapshot failed verification - ${problems.join("; ")}`);
  return files.reduce((total, file) => total + file.bytes, 0);
}

/**
 * Writes one target's snapshot under `<root>/<name>/<date>`, building it in a
 * sibling temp directory and renaming only once it has verified - so a run that
 * dies halfway leaves no directory that looks like a usable backup.
 */
export async function createSnapshot(
  target: BackupTarget,
  root: string,
  createdAt: Date,
  codec: ArchiveCodec = resolveArchiveCodec(),
): Promise<SnapshotReport> {
  const instanceRoot = path.join(root, target.name);
  const finalPath = path.join(instanceRoot, snapshotDateStamp(createdAt));
  const temporary = path.join(instanceRoot, `.tmp-${process.pid}-${crypto.randomUUID()}`);
  try {
    // Inside the try: creating these can fail on its own - a stale file sitting
    // where an instance directory belongs, a full or read-only disk - and that
    // has to become this target's failed report, not a throw that abandons
    // every target queued behind it.
    fs.mkdirSync(instanceRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(temporary, { mode: 0o700 });
    const bytes = await writeSnapshotInto(temporary, target, codec, createdAt);
    fs.rmSync(finalPath, { recursive: true, force: true });
    fs.renameSync(temporary, finalPath);
    return { name: target.name, status: "ok", bytes, path: finalPath };
  } catch (error) {
    return {
      name: target.name,
      status: "failed",
      bytes: 0,
      path: finalPath,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
