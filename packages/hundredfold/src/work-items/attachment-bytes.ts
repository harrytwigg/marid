import { createHash } from 'node:crypto';
import fs from 'node:fs';

/**
 * Byte-level helpers behind the content-addressed attachment store: the
 * best-effort durability sync, and the streaming hash+size a staged file is
 * measured by. Their own module so the row layer above stays about rows,
 * authority, and audit.
 */

export function fsyncBestEffort(target: string): void {
  try {
    const fd = fs.openSync(target, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Durability belt only — a failed fsync must not fail the upload.
  }
}

export function hashAndSize(target: string): { sha256: string; bytes: number } {
  const digest = createHash('sha256');
  const fd = fs.openSync(target, 'r');
  let bytes = 0;
  try {
    const chunk = Buffer.alloc(1024 * 1024);
    let read = 0;
    while ((read = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      digest.update(chunk.subarray(0, read));
      bytes += read;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { sha256: digest.digest('hex'), bytes };
}
