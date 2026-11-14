import fs from "node:fs";
import path from "node:path";
import { resolveArchiveCodec, type ArchiveCodec, type ArchiveCodecId } from "./codec.js";
import { pruneSnapshots, type PruneResult } from "./retention.js";
import { createSnapshot, type SnapshotReport } from "./snapshot.js";
import { resolveBackupTargets } from "./targets.js";

export const DEFAULT_RETENTION_DAYS = 14;
/** Roughly a fortnight of every home, with room for one that grows. */
export const DEFAULT_MAX_TOTAL_BYTES = 20 * 1024 * 1024 * 1024;

export interface BackupRunOptions {
  root: string;
  now: Date;
  retentionDays?: number;
  maxTotalBytes?: number;
  registryPath?: string;
  /** Overrides codec resolution. Both branches ship, so both must be drivable. */
  codec?: ArchiveCodec;
}

export interface BackupRunResult {
  root: string;
  createdAt: string;
  codec: ArchiveCodecId;
  status: "ok" | "failed";
  targets: SnapshotReport[];
  retention: PruneResult;
}

/**
 * Snapshots every registered home, then prunes.
 *
 * Targets are independent: one failing is recorded and the rest still run, so a
 * single broken home cannot cost the operator every other backup that night.
 * Pruning happens either way - the run that cannot write is exactly the one
 * where an unbounded pile of old snapshots would fill the disk.
 */
/** A target that failed before createSnapshot could report on itself. */
function failedTarget(name: string, root: string, error: unknown): SnapshotReport {
  return {
    name,
    status: "failed",
    bytes: 0,
    path: path.join(root, name),
    error: error instanceof Error ? error.message : String(error),
  };
}

export async function runBackupRun(options: BackupRunOptions): Promise<BackupRunResult> {
  fs.mkdirSync(options.root, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(options.root, 0o700); } catch { /* Windows has no POSIX modes */ }

  const codec = options.codec ?? resolveArchiveCodec();
  const targets: SnapshotReport[] = [];
  let unreadableRegistry: unknown;
  try {
    for (const target of resolveBackupTargets({ registryPath: options.registryPath })) {
      // Every target is caught here as well as inside createSnapshot, so target
      // independence holds structurally rather than depending on that function
      // never throwing.
      try {
        targets.push(await createSnapshot(target, options.root, options.now, codec));
      } catch (error) {
        targets.push(failedTarget(target.name, options.root, error));
      }
    }
  } catch (error) {
    unreadableRegistry = error;
  }

  // Pruning runs before that error is rethrown: retention is what bounds the
  // disk, so it has to survive the run it was supposed to accompany.
  const retention = pruneSnapshots({
    root: options.root,
    now: options.now,
    retentionDays: options.retentionDays ?? DEFAULT_RETENTION_DAYS,
    maxTotalBytes: options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
  });
  if (unreadableRegistry) throw unreadableRegistry;

  return {
    root: options.root,
    createdAt: options.now.toISOString(),
    codec: codec.id,
    status: targets.some((target) => target.status === "failed") ? "failed" : "ok",
    targets,
    retention,
  };
}
