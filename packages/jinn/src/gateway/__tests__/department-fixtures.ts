import fs from "node:fs";
import path from "node:path";
import { initDb } from "../../shared/db.js";
import { resolveJinnHome } from "../../shared/paths.js";
import { LEGACY_ADOPTION_MARKER, resetDepartmentRegistryForTests } from "../department-registry.js";
import { resetOrgRegistryForTests } from "../org-registry.js";

/** Fixtures for the department-scope suites: a real instance home with `org/` YAML. All names are invented. */

const orgDir = () => path.join(resolveJinnHome(), "org");

export function writeDepartmentFile(slug: string, text: string, name = "department.yaml"): string {
  const dir = path.join(orgDir(), slug);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, text, "utf-8");
  return file;
}

export function writeEmployeeFile(directory: string, name: string, extra: Record<string, string> = {}): string {
  const dir = path.join(orgDir(), directory);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.yaml`);
  const fields = { name, displayName: name, rank: "employee", engine: "claude", model: "sonnet", persona: `Works as ${name}`, ...extra };
  fs.writeFileSync(file, Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join("\n") + "\n", "utf-8");
  return file;
}

/** A skill the allow-list can name. */
export function writeSkill(name: string): void {
  const dir = path.join(resolveJinnHome(), "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: test skill\n---\n`, "utf-8");
}

/**
 * A clean org, a clean registry, and no recorded scopes: each case starts from "no department.yaml anywhere".
 * The database is one that has already been through its first refresh, so a refused file is held
 * dedicated as the spec says; pass `{ upgraded: false }` for a database that predates the scope table.
 */
export function resetDepartmentFixtures({ upgraded = true }: { upgraded?: boolean } = {}): void {
  fs.rmSync(orgDir(), { recursive: true, force: true });
  fs.rmSync(path.join(resolveJinnHome(), "skills"), { recursive: true, force: true });
  resetDepartmentRegistryForTests();
  resetOrgRegistryForTests();
  initDb().prepare("DELETE FROM department_scopes").run();
  if (upgraded) initDb().prepare("INSERT INTO department_scopes (slug, scope, recorded_at) VALUES (?, 'open', ?)").run(LEGACY_ADOPTION_MARKER, new Date().toISOString());
}
