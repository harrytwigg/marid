import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { logger } from "../shared/logger.js";
import { resolveJinnHome } from "../shared/paths.js";
import type { Employee } from "../shared/types.js";
import { isSystemEmployeeName, SYSTEM_EMPLOYEE_OVERRIDE_FIELDS } from "./system-employees.js";

function listEntries(dir: string, skipUnreadable: boolean): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (skipUnreadable) return [];
    throw err;
  }
}

/**
 * Recursively walk `dir`, invoking `visit` for every employee YAML file
 * (.yaml/.yml, skipping department.yaml). Stops early and returns the first
 * non-undefined value `visit` returns; visitors that never return a value
 * walk the whole tree. A directory that cannot be listed throws, unless
 * `skipUnreadable` says to pass over it.
 */
export function walkEmployeeYamls<T>(
  dir: string,
  visit: (fullPath: string) => T | undefined,
  options: { skipUnreadable?: boolean } = {},
): T | undefined {
  for (const entry of listEntries(dir, options.skipUnreadable === true)) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = walkEmployeeYamls(fullPath, visit, options);
      if (found !== undefined) return found;
    } else if (
      (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml")) &&
      entry.name !== "department.yaml"
    ) {
      const found = visit(fullPath);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/**
 * Every absolute `claudeConfigDir` an employee YAML under `orgDir` names, read from the
 * files rather than the roster. The department scan runs before the employee scan, and a
 * profile is protected whether or not its employee loads. An unreadable file or directory
 * is skipped, so it cannot stop the department scan; the employee scan reports it.
 */
export function employeeClaudeConfigDirs(orgDir: string): string[] {
  const dirs = new Set<string>();
  if (!fs.existsSync(orgDir)) return [];
  walkEmployeeYamls(orgDir, (fullPath) => {
    try {
      const data = yaml.load(fs.readFileSync(fullPath, "utf-8")) as { claudeConfigDir?: unknown } | null;
      const dir = typeof data?.claudeConfigDir === "string" ? data.claudeConfigDir.trim() : "";
      if (path.isAbsolute(dir)) dirs.add(dir);
    } catch {
      // skip unreadable files
    }
    return undefined;
  }, { skipUnreadable: true });
  return [...dirs];
}

/**
 * Find the YAML file for an employee by name.
 * Searches the current instance's org directory recursively.
 */
function findEmployeeYamlPath(name: string): string | undefined {
  const orgDir = path.join(resolveJinnHome(), "org");
  if (!fs.existsSync(orgDir)) return undefined;

  return walkEmployeeYamls(orgDir, (fullPath) => {
    try {
      const raw = fs.readFileSync(fullPath, "utf-8");
      const data = yaml.load(raw) as any;
      if (data?.name === name) return fullPath;
    } catch {
      // skip unreadable files
    }
    return undefined;
  });
}

/** Fields of an employee YAML that may be mutated via the update API.
 *  `name` is intentionally excluded — it is the immutable identity/lookup key. */
export interface EmployeeUpdate {
  displayName?: string;
  department?: string;
  rank?: Employee["rank"];
  engine?: string;
  model?: string;
  effortLevel?: string | null;
  persona?: string;
  reportsTo?: string | string[];
  cliFlags?: string[];
  alwaysNotify?: boolean;
}

/** The set of YAML keys the update path is allowed to write. `name` is never here. */
export const WRITABLE_FIELDS = [
  "displayName",
  "department",
  "rank",
  "engine",
  "model",
  "effortLevel",
  "persona",
  "reportsTo",
  "cliFlags",
  "alwaysNotify",
] as const;


/** The employee's YAML, creating the bare override file a built-in system employee has none of yet. */
function employeeYamlFor(name: string): string | undefined {
  const found = findEmployeeYamlPath(name);
  if (found || !isSystemEmployeeName(name)) return found;
  const systemDir = path.join(resolveJinnHome(), "org", "system");
  fs.mkdirSync(systemDir, { recursive: true });
  const created = path.join(systemDir, `${name}.yaml`);
  fs.writeFileSync(created, yaml.dump({ name }, { lineWidth: -1 }), "utf-8");
  return created;
}

/**
 * Update an employee's YAML file by read-merging the provided writable fields.
 * Only keys in WRITABLE_FIELDS are written; `name` is never touched (immutable).
 * Untouched YAML fields are preserved. Returns true on success, false if the
 * employee's YAML can't be found/parsed. Validate with validateEmployeeUpdate first.
 */
export function updateEmployeeYaml(
  name: string,
  updates: EmployeeUpdate,
): boolean {
  const filePath = employeeYamlFor(name);
  if (!filePath) return false;
  const systemEmployee = isSystemEmployeeName(name);

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = yaml.load(raw) as Record<string, unknown>;
    if (!data || typeof data !== "object") return false;

    const fields = systemEmployee ? SYSTEM_EMPLOYEE_OVERRIDE_FIELDS : WRITABLE_FIELDS;
    for (const key of fields) {
      const value = (updates as Record<string, unknown>)[key];
      if (value === null) {
        delete data[key];
      } else if (value !== undefined) {
        data[key] = value;
      }
    }
    // `name` is immutable — never write or rename it, even if present in `updates`.

    fs.writeFileSync(filePath, yaml.dump(data, { lineWidth: -1 }), "utf-8");
    return true;
  } catch (err) {
    logger.warn(`Failed to update employee YAML for ${name}: ${err}`);
    return false;
  }
}

/** Every employee YAML under `orgDir` by the `name` it declares; unreadable files and directories are skipped. */
export function employeeYamlPaths(orgDir: string): Map<string, string> {
  const paths = new Map<string, string>();
  if (!fs.existsSync(orgDir)) return paths;
  walkEmployeeYamls(orgDir, (fullPath) => {
    try {
      const data = yaml.load(fs.readFileSync(fullPath, "utf-8")) as { name?: unknown } | null;
      if (typeof data?.name === "string" && !paths.has(data.name)) paths.set(data.name, fullPath);
    } catch {
      // the employee scan reports it
    }
    return undefined;
  }, { skipUnreadable: true });
  return paths;
}
