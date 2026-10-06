import fs from "node:fs";
import { logger } from "../../shared/logger.js";
import { resolveJinnHome } from "../../shared/paths.js";
import { departmentRecord, departmentScopeOf, departmentSlugsWithFiles } from "../department-registry.js";
import { departmentStageDir } from "../department-scope/paths.js";
import { generateStageFileSet } from "./file-set.js";
import { syncStageDir } from "./sync.js";

/**
 * A department's stage directory on this machine (FR-020): generated from its definition,
 * synced in place (FR-020a) on the triggers (boot, a skill, instructions or department-scan
 * change) and before every scoped spawn. The path is the one the transcript slug and the
 * trust key derive from, so the directory is returned by its realpath, as the engine will
 * see its own cwd.
 */

type TrustSeeder = (stageDir: string) => void;
let seedTrust: TrustSeeder | null = null;

/**
 * Folder trust for a stage directory in the gateway's own Claude profile, written whenever
 * the directory is generated: without it the trust dialog sits in front of an unattended
 * terminal and the first turn hangs. The boot registers it; a session on a named profile
 * is also seeded in that profile, before its spawn (`ensureClaudeProfileTrust`). With none
 * registered, as in a test, nothing is written, so no suite touches the real `~/.claude.json`.
 */
export function setStageTrustSeeder(next: TrustSeeder | null): void {
  seedTrust = next;
}

/** The stage directory's path as the engine sees it. A directory that does not exist yet is returned as written. */
export function resolvedStageDir(slug: string): string {
  const dir = departmentStageDir(slug);
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}

/** Sync department `slug`'s stage directory to what its definition says now, and return where it is. Throws when it cannot be written. */
export function prepareDepartmentStage(slug: string): string {
  const { files } = generateStageFileSet({ home: resolveJinnHome(), slug, definition: departmentRecord(slug).definition });
  const dir = departmentStageDir(slug);
  try {
    syncStageDir(dir, files);
  } catch (err) {
    throw new Error(`the stage directory for department "${slug}" could not be prepared: ${err instanceof Error ? err.message : String(err)}`);
  }
  const resolved = resolvedStageDir(slug);
  try {
    seedTrust?.(resolved);
  } catch (err) {
    logger.warn(`Could not seed folder trust for the stage directory ${resolved}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return resolved;
}

/** Sync the stage directory of every department that is not open. A failure is logged and does not stop the rest; the next spawn syncs again and refuses if it still cannot. */
export function syncDepartmentStages(only?: string): void {
  const slugs = only === undefined ? departmentSlugsWithFiles() : [only];
  for (const slug of slugs) {
    if (departmentScopeOf(slug) === "open") continue;
    try {
      prepareDepartmentStage(slug);
    } catch (err) {
      logger.warn(err instanceof Error ? err.message : String(err));
    }
  }
}
