import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ArchiveCodecId } from "./codec.js";

export const MANIFEST_FILE = "manifest.json";

export interface BackupManifestFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface BackupManifest {
  schemaVersion: 1;
  instance: string;
  home: string;
  createdAt: string;
  codec: ArchiveCodecId;
  uncompressedBytes: number;
  compressedBytes: number;
  files: BackupManifestFile[];
}

export function sha256File(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function describeFile(directory: string, name: string): BackupManifestFile {
  const target = path.join(directory, name);
  return { path: name, bytes: fs.statSync(target).size, sha256: sha256File(target) };
}

export function writeManifest(directory: string, manifest: BackupManifest): void {
  fs.writeFileSync(
    path.join(directory, MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  );
}

export function readManifest(directory: string): BackupManifest {
  const parsed = JSON.parse(fs.readFileSync(path.join(directory, MANIFEST_FILE), "utf8")) as BackupManifest;
  if (parsed.schemaVersion !== 1) throw new Error(`unsupported backup manifest version ${String(parsed.schemaVersion)}`);
  if (!Array.isArray(parsed.files) || parsed.files.length === 0) throw new Error("backup manifest records no files");
  return parsed;
}

/**
 * Re-hashes what is on disk against what the manifest recorded. A zero-byte
 * entry is called out separately: it is the failure a full disk or a killed
 * compressor produces, and it is the one a size check alone would let through
 * as "well, the sha256 of nothing does match the sha256 of nothing".
 */
export function verifyManifest(directory: string, manifest: BackupManifest): string[] {
  const problems: string[] = [];
  for (const entry of manifest.files) {
    if (entry.path !== path.basename(entry.path)) {
      problems.push(`${entry.path}: manifest entries must name a file inside the snapshot`);
      continue;
    }
    const target = path.join(directory, entry.path);
    if (!fs.existsSync(target)) {
      problems.push(`${entry.path}: missing from the snapshot`);
      continue;
    }
    const bytes = fs.statSync(target).size;
    if (bytes === 0) problems.push(`${entry.path}: is empty`);
    else if (bytes !== entry.bytes) problems.push(`${entry.path}: expected ${entry.bytes} bytes, found ${bytes}`);
    else if (sha256File(target) !== entry.sha256) problems.push(`${entry.path}: sha256 does not match the manifest`);
  }
  return problems;
}
