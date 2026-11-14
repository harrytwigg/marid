import fs from "node:fs";
import path from "node:path";
import { claudeProjectSlug } from "./claude-project-slug.js";

/**
 * Claude Code files a conversation under `<config dir>/projects/<slug of the cwd it ran in>`, and
 * resumes, forks and compacts it by that key. A cwd that is renamed therefore orphans its
 * conversations unless the project directory follows it, in every profile it was written under.
 * A symlink at the old path does not help: the process's cwd is the physical path.
 */

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

/** Bring `source`'s entries into `target`, which a session already ran under: only what `target` does not have. */
function mergeProjectDirs(source: string, target: string): void {
  for (const entry of fs.readdirSync(source)) {
    if (!exists(path.join(target, entry))) fs.renameSync(path.join(source, entry), path.join(target, entry));
  }
  try {
    fs.rmdirSync(source);
  } catch { /* something is left that the new key already has */ }
}

export interface TranscriptMove {
  from: string;
  to: string;
}

/**
 * Move the project directory for the cwd `from` to the key for the cwd `to`, in each of `configDirs`.
 * Returns the moves it made. A move that fails is reported to `onError` and the others carry on.
 */
export function moveTranscripts(
  from: string,
  to: string,
  configDirs: Iterable<string>,
  onError: (message: string) => void = () => undefined,
): TranscriptMove[] {
  const fromKey = claudeProjectSlug(from);
  const toKey = claudeProjectSlug(to);
  if (fromKey === toKey) return [];
  const moved: TranscriptMove[] = [];
  for (const configDir of new Set(configDirs)) {
    const source = path.join(configDir, "projects", fromKey);
    const target = path.join(configDir, "projects", toKey);
    if (!isRealDirectory(source)) continue;
    try {
      if (exists(target)) mergeProjectDirs(source, target);
      else fs.renameSync(source, target);
      moved.push({ from: source, to: target });
    } catch (err) {
      onError(`Could not move the transcripts under ${source} to ${target}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return moved;
}
