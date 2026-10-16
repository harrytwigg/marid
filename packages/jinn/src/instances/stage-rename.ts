import fs from "node:fs";
import path from "node:path";
import { LEGACY_CODENAME, NAMES, currentInstanceName, type Names } from "../shared/codename.js";
import { moveTranscripts } from "../shared/claude-transcript-move.js";

/**
 * A home's department stage directories live beside it, in a root of the instance's own:
 * `<parent>/.<codename>-departments/.instances/<basename of the home>/<department>/`. A rename of the
 * codename changes the container's name and the home's basename, so the root moves, and the transcripts
 * Claude Code filed under each stage directory's old path move with it (the project key is the path).
 */

/** The instances directory inside a stage container (department-workdirs.ts). Spelled here so this module needs none of the gateway's paths. */
const INSTANCES_DIR = ".instances";

function isRealDirectory(target: string): boolean {
  try {
    return fs.lstatSync(target).isDirectory();
  } catch {
    return false;
  }
}

function exists(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

export interface StageRenameResult {
  from: string;
  to: string;
  /** Project directories moved, summed over every Claude profile. */
  transcripts: number;
  departments: string[];
}

/** The stage root an instance's home keeps its departments in, under `names`' container and instance name. */
export function stageRootFor(home: string, names: Names, legacy: boolean): string {
  const container = `.${legacy ? LEGACY_CODENAME : names.codename}-departments`;
  // The root is keyed by the home's own directory name, dot included (department-workdirs.ts).
  const base = path.basename(home);
  const dotted = base.startsWith(".");
  const instance = dotted ? base.slice(1) : base;
  const named = legacy ? instance : currentInstanceName(instance, names);
  return path.join(path.dirname(home), container, INSTANCES_DIR, dotted ? `.${named}` : named);
}

/**
 * Move the stage root the legacy codename made for `legacyHome` to the one this build uses for
 * `currentHome`, with the transcripts. Nothing happens unless the old root is a real directory and the
 * new one does not exist. The old container is removed when that leaves it empty.
 */
export function renameStageRoot(
  legacyHome: string,
  currentHome: string,
  configDirs: Iterable<string>,
  options: { names?: Names; onError?: (message: string) => void } = {},
): StageRenameResult | undefined {
  const names = options.names ?? NAMES;
  const from = stageRootFor(legacyHome, names, true);
  const to = stageRootFor(currentHome, names, false);
  if (from === to || !isRealDirectory(from) || exists(to)) return undefined;
  const physicalFrom = fs.realpathSync(from);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  const physicalTo = fs.realpathSync(to);
  const dirs = [...configDirs];
  const departments: string[] = [];
  let transcripts = 0;
  for (const entry of fs.readdirSync(to, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    departments.push(entry.name);
    transcripts += moveTranscripts(path.join(physicalFrom, entry.name), path.join(physicalTo, entry.name), dirs, options.onError).length;
  }
  removeIfEmpty(path.dirname(from));
  removeIfEmpty(path.dirname(path.dirname(from)));
  return { from, to, transcripts, departments };
}

function removeIfEmpty(directory: string): void {
  try {
    fs.rmdirSync(directory);
  } catch { /* not empty, or already gone: another instance's roots are still in it */ }
}
