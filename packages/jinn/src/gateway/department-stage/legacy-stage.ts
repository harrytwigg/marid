import fs from "node:fs";
import path from "node:path";
import { claudeProjectSlug } from "../../engines/claude-transcript-path.js";
import { protectedClaudeConfigDirs } from "../../shared/claude-profile.js";
import { logger } from "../../shared/logger.js";
import { departmentStageDir } from "../department-scope/paths.js";
import { departmentStageRoot, departmentStagesContainer } from "../department-workdirs.js";
import { STAGE_CLAUDE_MD } from "./file-set.js";

/**
 * Moving a stage directory made before the stage root was keyed by instance (FR-020a).
 *
 * The old path was `<parent>/.jinn-departments/<slug>/`; it is now
 * `<parent>/.jinn-departments/.instances/<instance>/<slug>/`. The directory is renamed, not copied,
 * so its inode is the one a running session already has as its cwd, and it is moved once:
 * after that the new path is the only one anything looks at. The transcripts Claude Code
 * filed under the old path's project key follow it, so resume, fork and auto-compaction
 * find them under the new key.
 *
 * Two instances under one parent could both have a directory at the old path, which was
 * the bug. Whichever prepares its stage directory first takes it, with every transcript
 * filed under that path's project key (the other instance's sessions of that department
 * included, as the key cannot tell them apart); the other finds nothing there and
 * generates its own. The instance roots live under a dot-named directory (`STAGE_INSTANCES_DIR`),
 * which no old-layout stage directory can be, so the two layouts never share a path.
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

/** A stage directory is told from another instance's root by its generated `CLAUDE.md`, which a root of stage directories never has. */
function isLegacyStageDir(dir: string): boolean {
  try {
    return fs.lstatSync(dir).isDirectory() && fs.lstatSync(path.join(dir, STAGE_CLAUDE_MD)).isFile();
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

/** Move Claude Code's project directory for `from` to the key for `to`, in every profile it may have been written under. */
function moveTranscripts(from: string, to: string): void {
  const fromKey = claudeProjectSlug(from);
  const toKey = claudeProjectSlug(to);
  if (fromKey === toKey) return;
  for (const configDir of new Set(protectedClaudeConfigDirs())) {
    const source = path.join(configDir, "projects", fromKey);
    const target = path.join(configDir, "projects", toKey);
    if (!isRealDirectory(source)) continue;
    try {
      if (exists(target)) mergeProjectDirs(source, target);
      else fs.renameSync(source, target);
    } catch (err) {
      logger.warn(`Could not move the transcripts under ${source} to ${target}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Incoming directories the old sync left beside the old stage directory: nothing reaps them there any more. */
function reapLegacyIncoming(slug: string): void {
  const container = departmentStagesContainer();
  const prefix = `.${slug}.incoming-`;
  try {
    for (const entry of fs.readdirSync(container, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith(prefix)) fs.rmSync(path.join(container, entry.name), { recursive: true, force: true });
    }
  } catch { /* nothing to reap */ }
}

/**
 * Move department `slug`'s stage directory from the old path to this instance's root, once.
 * Returns whether it moved one. Nothing is moved when the new path exists already, when the
 * old path is a link or is not a stage directory, or when there is no old one; a failure is
 * logged, and the sync then makes the directory fresh.
 */
export function migrateLegacyStageDir(slug: string): boolean {
  const legacy = path.join(departmentStagesContainer(), slug);
  const target = departmentStageDir(slug);
  if (!isLegacyStageDir(legacy) || exists(target)) return false;
  try {
    const before = fs.realpathSync(legacy);
    fs.mkdirSync(departmentStageRoot(), { recursive: true });
    fs.renameSync(legacy, target);
    moveTranscripts(before, fs.realpathSync(target));
    reapLegacyIncoming(slug);
    logger.info(`Moved department "${slug}"'s stage directory from ${legacy} to ${target}`);
    return true;
  } catch (err) {
    logger.warn(`Could not move department "${slug}"'s stage directory from ${legacy} to ${target}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
