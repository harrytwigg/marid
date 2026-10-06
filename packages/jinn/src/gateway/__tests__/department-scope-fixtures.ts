import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { context, home } from "./department-scope-harness.js";

/**
 * Extra fixtures for the department-scope suites, on top of the shared harness: a
 * working directory for the side project, and the org rewritten around it.
 */

/** A git work tree beside the home (a department workdir must be one), holding `name`. */
export function makeWorkdir(label: string, file = "notes.txt"): { dir: string; file: string } {
  const dir = fs.realpathSync(fs.mkdtempSync(`${home}-${label}-`));
  execFileSync("git", ["init", "-q", dir]);
  const target = path.join(dir, file);
  fs.writeFileSync(target, "department file\n");
  return { dir, file: target };
}

/** A readable file that is in no department's working directory. */
export function makeOutsideFile(): string {
  return makeWorkdir("outside", "elsewhere.txt").file;
}

/** Rewrite side-project's department.yaml with extra lines, and reload the org. */
export async function rewriteSideProject(extra: string[]): Promise<void> {
  fs.writeFileSync(
    path.join(home, "org", "side-project", "department.yaml"),
    ["name: side-project", "scope: scoped", "skills: [dev-workflow]", ...extra, ""].join("\n"),
  );
  const { refreshOrg } = await import("../org-registry.js");
  refreshOrg(context.getConfig());
}
