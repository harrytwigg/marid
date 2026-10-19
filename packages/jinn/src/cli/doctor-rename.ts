import os from "node:os";
import { NAMES, currentInstanceName } from "../shared/codename.js";
import { resolveJinnHome } from "../shared/home.js";
import { claudeConfigDirsOf } from "../instances/claude-profile-dirs.js";
import { inspectHome } from "../instances/home-state.js";
import { switchOver, type SwitchoverOptions, type SwitchoverReport } from "../instances/switchover.js";

/**
 * `doctor --rename`: what switching this instance over to the current codename would change, and, with
 * `--apply`, the change. Without `--apply` it only reports.
 */

/** Snapshot the home before it is edited, with the backup run's own snapshot. */
async function snapshotHome(home: string): Promise<string | undefined> {
  const { createSnapshot } = await import("../backup/snapshot.js");
  const { resolveArchiveCodec } = await import("../backup/codec.js");
  const { backupRootFor } = await import("../instances/backup-rename.js");
  // Its own directory, so it does not replace the snapshot the home's move took the same day.
  const instance = currentInstanceName(home.split(/[\\/]/).pop()?.replace(/^\./, "") ?? NAMES.codename);
  const report = await createSnapshot({ name: `${instance}-before-switchover`, home }, backupRootFor(os.homedir()), new Date(), resolveArchiveCodec());
  if (report.status !== "ok") throw new Error(report.error ?? "the snapshot failed");
  return report.path;
}

/** Why the switch-over cannot run yet, from where the home stands, or undefined when it can. */
function homeBlocker(home: string): string | undefined {
  const { state, legacy, current } = inspectHome(home);
  if (state === "pending-move") return `the home is still at ${legacy}: start it once, with nothing running there, so it moves to ${current}, then run this again`;
  if (state === "conflict") return `both ${legacy} and ${current} exist: settle which holds your data first (see the other findings)`;
  return undefined;
}

export async function renameReport(
  options: { apply?: boolean; home?: string; deps?: Partial<SwitchoverOptions> } = {},
): Promise<SwitchoverReport> {
  const home = options.home ?? resolveJinnHome();
  const report = await switchOver({
    home,
    profileDirs: claudeConfigDirsOf(home),
    apply: options.apply && homeBlocker(home) === undefined,
    backup: snapshotHome,
    ...options.deps,
  });
  const blocker = options.apply ? homeBlocker(home) : undefined;
  return blocker ? { ...report, blockers: [blocker, ...report.blockers] } : report;
}

export function printRenameReport(report: SwitchoverReport, apply: boolean): void {
  if (report.findings.length === 0) console.log("Nothing names the old codename in this instance's configuration, skills, prompts or permission lists.");
  for (const finding of report.findings) console.log(`${apply ? "changed" : "would change"}  ${finding.file}\n    ${finding.what}${finding.count > 1 ? ` (${finding.count} places)` : ""}`);
  for (const blocker of report.blockers) console.log(`ACTION  ${blocker}`);
  if (report.applied) {
    console.log(`\nSwitched over. The originals are kept in ${report.applied.copies}${report.applied.snapshot ? `; a snapshot is at ${report.applied.snapshot}` : ""}.`);
    console.log("Start the gateway: the built-in server is now registered under the new name, and sessions begin with it.");
  } else if (!apply && report.findings.length > 0) {
    console.log("\nNothing was changed. Stop the gateway, then run again with --apply.");
  }
}
