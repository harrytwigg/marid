import { logger } from "../shared/logger.js";
import { JINN_HOME, TEMPLATE_DIR } from "../shared/paths.js";
import { getPackageVersion } from "../shared/version.js";
import { syncTemplateSkills } from "./sync-template-skills.js";

/** Upgrading replaces the skills Jinn ships and stamps the new version — silently, on
 *  every boot. Skills the operator wrote are left alone, and a failure is logged rather
 *  than allowed to stop the gateway from starting. */
export function syncShippedSkills(): void {
  try {
    const result = syncTemplateSkills({
      instanceHome: JINN_HOME,
      templateDir: TEMPLATE_DIR,
      packageVersion: getPackageVersion(),
    });
    if (result.added.length + result.updated.length + result.removed.length === 0) return;
    logger.info(
      `Synced shipped skills: ${result.added.length} added, ${result.updated.length} updated, ${result.removed.length} removed`
      + (result.backupDir ? ` (previous copies in ${result.backupDir})` : ""),
    );
  } catch (error) {
    logger.error(`Could not sync the skills Marid ships: ${error instanceof Error ? error.message : String(error)}`);
  }
}
