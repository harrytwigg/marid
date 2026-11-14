import fs from "node:fs";
import path from "node:path";
import { loadInstances, type DirectoryOptions } from "../instances/directory.js";

/** One instance home the backup run will snapshot. */
export interface BackupTarget {
  name: string;
  home: string;
}

/**
 * `kind` does not discriminate sandboxes — every entry normalizes to
 * "workspace" — so selection is the literal rule: registered, the directory is
 * still there, and it holds a config.yaml. The last check is what separates a
 * home from a directory that merely survived the instance being removed.
 */
function isInstanceHome(home: string): boolean {
  try {
    return fs.statSync(path.join(home, "config.yaml")).isFile();
  } catch {
    return false;
  }
}

export function resolveBackupTargets(options: DirectoryOptions = {}): BackupTarget[] {
  return loadInstances(options)
    .filter((instance) => isInstanceHome(instance.home))
    .map((instance) => ({ name: instance.name, home: instance.home }));
}
