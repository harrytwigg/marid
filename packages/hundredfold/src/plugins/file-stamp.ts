import fs from "node:fs/promises";

/**
 * The version of a plugin file, as everything that caches one keys on it: the
 * backend's module cache and the client half's transform cache both have to
 * notice the same edit, and a stamp each would be two chances to disagree.
 *
 * Null when the file is gone, which drops the cached entry rather than serving
 * the last version that happened to succeed.
 */
export async function fileStamp(file: string): Promise<string | null> {
  try {
    const stat = await fs.stat(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}
