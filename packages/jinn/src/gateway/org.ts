import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { resolveJinnHome } from "../shared/paths.js";
import type { Employee, JinnConfig } from "../shared/types.js";
import type { DepartmentScope } from "../work-items/department-scope.js";
import { logger } from "../shared/logger.js";
import { getModelRegistry, effortLevelsForModel, hasDynamicModelCatalog } from "../shared/models.js";
import { validateEmployeeTargets } from "../shared/claude-profile.js";
import { departmentDisagreement } from "./org-department-check.js";
import { walkEmployeeYamls, WRITABLE_FIELDS, type EmployeeUpdate } from "./org-yaml-files.js";
import {
  resolveSystemEmployees,
  SYSTEM_EMPLOYEE_OVERRIDE_FIELDS,
} from "./system-employees.js";

export { updateEmployeeYaml, type EmployeeUpdate } from "./org-yaml-files.js";

/** `scopeOf` answers how scoped a department is; the default holds every department open, so a scan that is handed none reads the org as it always did. */
export function scanOrg(config?: JinnConfig, scopeOf: (slug: string) => DepartmentScope = () => "open"): Map<string, Employee> {
  const registry = new Map<string, Employee>(
    resolveSystemEmployees(config).map((employee) => [employee.name, employee]),
  );
  const orgDir = path.join(resolveJinnHome(), "org");

  if (!fs.existsSync(orgDir)) return registry;

  walkEmployeeYamls(orgDir, (fullPath) => {
    try {
      const raw = fs.readFileSync(fullPath, "utf-8");
      const data = yaml.load(raw) as any;
      if (data && data.name) {
        // The operator/system sentinels and the session:<uuid> namespace are
        // author identities on Todo surfaces (comments, created_by). An
        // employee slug claiming one could impersonate — or act with the
        // authority of — another principal, so those names can never be
        // registered. Skip the file (the rest of the org keeps loading).
        const name = String(data.name);
        if (/^(operator|system)$/i.test(name) || /^(session|cron|workflow):/i.test(name) || name.startsWith("@")) {
          logger.warn(
            `Skipping employee file ${fullPath}: the name "${name}" collides with a reserved author identity (operator, system, session:*, cron:*, workflow:*, or an @-prefixed assignee)`,
          );
          return undefined;
        }
        const builtIn = registry.get(name);
        if (builtIn?.system) {
          const employee = { ...builtIn };
          if (typeof data.engine === "string" && data.engine.trim()) employee.engine = data.engine.trim();
          if (typeof data.model === "string" && data.model.trim()) employee.model = data.model.trim();
          if (typeof data.effortLevel === "string" && data.effortLevel.trim()) employee.effortLevel = data.effortLevel.trim();
          if (typeof data.alwaysNotify === "boolean") employee.alwaysNotify = data.alwaysNotify;
          registry.set(name, employee);
          return undefined;
        }
        if (!data.persona) return undefined;
        const employee: Employee = {
          name: data.name,
          displayName: data.displayName || data.name,
          department:
            data.department || path.basename(path.dirname(fullPath)),
          rank: data.rank || "employee",
          engine: data.engine || "claude",
          model: data.model || "sonnet",
          persona: data.persona,
          emoji: typeof data.emoji === "string" ? data.emoji : undefined,
          cliFlags: Array.isArray(data.cliFlags) ? data.cliFlags : undefined,
          effortLevel: typeof data.effortLevel === "string" ? data.effortLevel : undefined,
          alwaysNotify: typeof data.alwaysNotify === "boolean" ? data.alwaysNotify : true,
          reportsTo: data.reportsTo ?? undefined,
          mcp: data.mcp ?? undefined,
          // GRS-017e: per-employee jinn-toolset override (force-on pilot /
          // force-off). Boolean-checked like the other optional flags — the
          // scan whitelist previously dropped it, which live QA phase D caught
          // (a YAML pilot could never arm the smoke gate).
          jinnMcp: typeof data.jinnMcp === "boolean" ? data.jinnMcp : undefined,
          // Remote (SSH) execution. Validated immediately below — a bad remote
          // target fails THIS employee's load loudly at boot rather than at the
          // first turn, because the failure it guards against (an unattended
          // --dangerously-skip-permissions session outside the sandbox root) is
          // not one to discover mid-task.
          remoteHost: typeof data.remoteHost === "string" ? data.remoteHost.trim() : undefined,
          remoteUser: typeof data.remoteUser === "string" ? data.remoteUser.trim() : undefined,
          remoteCwd: typeof data.remoteCwd === "string" ? data.remoteCwd.trim() : undefined,
          remoteClaudeConfigDir: typeof data.remoteClaudeConfigDir === "string" ? data.remoteClaudeConfigDir.trim() : undefined,
          claudeConfigDir: data.claudeConfigDir ?? undefined,
          provides: Array.isArray(data.provides)
            ? data.provides.filter((s: unknown) => s && typeof s === "object" && typeof (s as any).name === "string" && typeof (s as any).description === "string")
              .map((s: any) => ({ name: s.name as string, description: s.description as string }))
            : undefined,
        };
        const departmentProblem = departmentDisagreement(orgDir, fullPath, data.department, scopeOf);
        if (departmentProblem) {
          // Same containment as a bad remote target: this employee does not load, the
          // rest of the org does. A scoped department's members are confined by what
          // the roster says their department is, so an ambiguous one is refused.
          logger.error(`Skipping employee file ${fullPath}: ${departmentProblem}`);
          return undefined;
        }
        const problem = validateEmployeeTargets(employee, config?.remote);
        if (problem) {
          // Skip THIS employee, keep loading the rest — same containment the
          // reserved-name guard above uses. Dropping the whole org because one
          // YAML names an unconfigured host would be a worse outage than the
          // misconfiguration it reports.
          logger.error(`Skipping employee file ${fullPath}: ${problem}`);
          return undefined;
        }
        registry.set(employee.name, employee);
      }
    } catch (err) {
      logger.warn(`Failed to parse employee file ${fullPath}: ${err}`);
    }
    return undefined; // keep walking — scanOrg visits every file
  });

  return registry;
}

const VALID_RANKS: ReadonlyArray<Employee["rank"]> = [
  "executive",
  "manager",
  "senior",
  "employee",
];

export interface EmployeeUpdateResult {
  ok: boolean;
  updates?: EmployeeUpdate;
  error?: string;
}

/**
 * Validate an employee update body against the model/engine registry and the
 * Employee type's constraints. Pure — does no IO. Rejects:
 *  - `name` (immutable) and any key not in WRITABLE_FIELDS
 *  - empty/whitespace displayName or persona (an empty persona makes scanOrg drop
 *    the employee — G3)
 *  - an invalid rank enum
 *  - an unknown engine, or a model/effortLevel invalid for the *resulting* engine
 *  - wrong-typed cliFlags / alwaysNotify / reportsTo
 *
 * `current` supplies the existing engine/model so model+effort can be validated
 * even when those fields aren't part of this update.
 */
export function validateEmployeeUpdate(
  config: JinnConfig,
  current: Employee,
  body: Record<string, unknown>,
): EmployeeUpdateResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "update body must be a JSON object" };
  }

  if ("name" in body) {
    return { ok: false, error: "field 'name' is immutable and cannot be changed" };
  }

  if (current.system) {
    const protectedFields = Object.keys(body).filter(
      (key) => !(SYSTEM_EMPLOYEE_OVERRIDE_FIELDS as readonly string[]).includes(key),
    );
    if (protectedFields.length > 0) {
      return {
        ok: false,
        error: `system employee field(s) cannot be changed: ${protectedFields.join(", ")}`,
      };
    }
  }

  const unknownKeys = Object.keys(body).filter(
    (k) => !(WRITABLE_FIELDS as readonly string[]).includes(k),
  );
  if (unknownKeys.length > 0) {
    return { ok: false, error: `unknown field(s): ${unknownKeys.join(", ")}` };
  }

  const updates: EmployeeUpdate = {};

  // --- non-empty string fields ---
  for (const key of ["displayName", "department", "persona"] as const) {
    if (body[key] !== undefined) {
      const v = body[key];
      if (typeof v !== "string" || !v.trim()) {
        return { ok: false, error: `${key} must be a non-empty string` };
      }
      updates[key] = v;
    }
  }

  // --- rank enum ---
  if (body.rank !== undefined) {
    if (typeof body.rank !== "string" || !VALID_RANKS.includes(body.rank as Employee["rank"])) {
      return { ok: false, error: `invalid rank "${String(body.rank)}" (valid: ${VALID_RANKS.join(", ")})` };
    }
    updates.rank = body.rank as Employee["rank"];
  }

  // --- engine (must exist in the registry) ---
  const registry = getModelRegistry(config);
  if (body.engine !== undefined) {
    if (typeof body.engine !== "string" || !body.engine.trim()) {
      return { ok: false, error: "engine must be a non-empty string" };
    }
    const engineId = body.engine.trim();
    if (!registry[engineId]) {
      const known = Object.keys(registry).join(", ");
      return { ok: false, error: `unknown engine "${engineId}" (known: ${known || "none"})` };
    }
    updates.engine = engineId;
  }

  const resultingEngine = updates.engine ?? current.engine;

  // --- model (valid for the resulting engine) ---
  if (body.model !== undefined) {
    if (typeof body.model !== "string" || !body.model.trim()) {
      return { ok: false, error: "model must be a non-empty string" };
    }
    const modelId = body.model.trim();
    const entry = registry[resultingEngine];
    if (entry && !entry.models.some((m) => m.id === modelId)) {
      if (hasDynamicModelCatalog(resultingEngine)) {
        // Discovered-only catalog; tolerate an id the snapshot hasn't caught yet.
        logger.warn(`${resultingEngine} model "${modelId}" not in discovered set yet — allowing`);
      } else {
        const known = entry.models.map((m) => m.id).join(", ");
        return { ok: false, error: `unknown model "${modelId}" for engine "${resultingEngine}" (known: ${known || "none"})` };
      }
    }
    updates.model = modelId;
  }

  // --- effortLevel (valid for the resulting engine+model) ---
  const effectiveModel = updates.model ?? current.model ?? undefined;
  if (body.effortLevel !== undefined) {
    if (typeof body.effortLevel !== "string" || !body.effortLevel.trim()) {
      return { ok: false, error: "effortLevel must be a non-empty string" };
    }
    const level = body.effortLevel.trim();
    const valid = effortLevelsForModel(config, resultingEngine, effectiveModel);
    if (valid.length === 0) {
      return { ok: false, error: `engine "${resultingEngine}"${effectiveModel ? ` model "${effectiveModel}"` : ""} does not support effort levels` };
    }
    if (!valid.includes(level)) {
      return { ok: false, error: `invalid effortLevel "${level}" (valid: ${valid.join(", ")})` };
    }
    updates.effortLevel = level;
  } else if (current.effortLevel) {
    const level = current.effortLevel.trim();
    const valid = effortLevelsForModel(config, resultingEngine, effectiveModel);
    if (level && (valid.length === 0 || !valid.includes(level))) {
      updates.effortLevel = null;
    }
  }

  // --- reportsTo (string | string[]) ---
  if (body.reportsTo !== undefined) {
    const v = body.reportsTo;
    const isString = typeof v === "string" && v.trim().length > 0;
    const isStringArray = Array.isArray(v) && v.every((x) => typeof x === "string" && x.trim().length > 0);
    if (!isString && !isStringArray) {
      return { ok: false, error: "reportsTo must be a non-empty string or array of strings" };
    }
    updates.reportsTo = v as string | string[];
  }

  // --- cliFlags (string[]) ---
  if (body.cliFlags !== undefined) {
    const v = body.cliFlags;
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
      return { ok: false, error: "cliFlags must be an array of strings" };
    }
    updates.cliFlags = v as string[];
  }

  // --- alwaysNotify (boolean) ---
  if (body.alwaysNotify !== undefined) {
    if (typeof body.alwaysNotify !== "boolean") {
      return { ok: false, error: "alwaysNotify must be a boolean" };
    }
    updates.alwaysNotify = body.alwaysNotify;
  }

  if (Object.keys(updates).length === 0) {
    return { ok: false, error: "no recognized fields to update" };
  }

  return { ok: true, updates };
}

export function extractMention(
  text: string,
  registry: Map<string, Employee>,
): Employee | undefined {
  for (const [name, employee] of registry) {
    if (text.includes(`@${name}`)) {
      return employee;
    }
  }
  return undefined;
}
