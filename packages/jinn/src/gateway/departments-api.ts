import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { initDb } from "../shared/db.js";
import { resolveJinnHome } from "../shared/paths.js";
import type { DepartmentScope } from "../work-items/department-scope.js";
import { departmentSpend, listDepartmentsWithCounts, type DepartmentSummary } from "../work-items/departments.js";
import { ensureDepartmentRegistered, resolveTodoDepartments } from "../work-items/store.js";
import { departmentRecord, departmentSlugsWithFiles, type DepartmentRecord } from "./department-registry.js";
import { DepartmentWriteError, readDepartmentPatch, writeDepartmentFile } from "./department-store.js";
import { readJsonBody } from "./http-helpers.js";
import { orgRegistry, refreshOrg } from "./org-registry.js";
import { badRequest, json, matchRoute, notFound, type ParsedRoute } from "./route-helpers.js";
import type { ApiContext } from "./api.js";

/**
 * The department routes.
 *
 *   GET   /api/departments        the registry rows, each with its definition
 *   GET   /api/departments/:slug  one department in full
 *   PATCH /api/departments/:slug  rewrite that department's `department.yaml` (operator only)
 *
 * Writes are operator-only: `control-plane-routes.ts` lists the PATCH and api.ts
 * enforces that table before any module is asked. Nothing here restricts what an
 * employee can see or do; a scope only changes how assignment and sub-tasks behave
 * until scoped employees are enforced.
 */

export interface DepartmentDefinitionFields {
  scope: DepartmentScope;
  displayName: string | null;
  description: string | null;
  members: string[];
  definitionFile: string | null;
  definitionError: string | null;
}

export type DepartmentRow = DepartmentSummary & DepartmentDefinitionFields;

export type DepartmentDefinitionWire = DepartmentDefinitionFields & {
  slug: string;
  prefix: string | null;
  workdirs: string[];
  skills: string[];
  sharedNotes: string[];
  instructions: "department" | "department+company";
  todoCount: number;
  spendUsd: number;
  /** Entries the scan dropped, each with its reason. */
  warnings: string[];
};

function fields(record: DepartmentRecord, members: string[]): DepartmentDefinitionFields {
  return {
    scope: record.scope,
    displayName: record.definition?.displayName ?? null,
    description: record.definition?.description ?? null,
    members,
    definitionFile: record.definitionFile,
    definitionError: record.definitionError,
  };
}

function membersByDepartment(context: ApiContext): Map<string, string[]> {
  const byDepartment = new Map<string, string[]>();
  for (const employee of orgRegistry(context.getConfig()).values()) {
    byDepartment.set(employee.department, [...(byDepartment.get(employee.department) ?? []), employee.name]);
  }
  for (const names of byDepartment.values()) names.sort();
  return byDepartment;
}

function listRows(context: ApiContext): DepartmentRow[] {
  const policy = resolveTodoDepartments();
  // A department that has been given a scope is on the board before its first Todo,
  // like a department a closed policy allows.
  for (const slug of policy?.allowed ?? []) ensureDepartmentRegistered(slug);
  // Not one whose file was refused: that is held dedicated until it loads, and a read does not mint it a permanent prefix.
  for (const slug of departmentSlugsWithFiles()) {
    const record = departmentRecord(slug);
    if (record.scope !== "open" && !record.definitionError) ensureDepartmentRegistered(slug);
  }
  const members = membersByDepartment(context);
  return listDepartmentsWithCounts(initDb(), policy?.allowed).map((row) => ({
    ...row,
    ...fields(departmentRecord(row.slug), members.get(row.slug) ?? []),
  }));
}

/** A department exists when it has a registry row, a directory under `org/`, a definition file, or an employee whose `department:` names it. */
function knownDepartment(slug: string, context: ApiContext): boolean {
  if (initDb().prepare("SELECT 1 FROM departments WHERE slug = ?").get(slug)) return true;
  if (departmentSlugsWithFiles().includes(slug)) return true;
  // A department may exist only as an employee's `department:` field; the org tree groups it, so its panel must open.
  if ([...orgRegistry(context.getConfig()).values()].some((employee) => employee.department === slug)) return true;
  try {
    return fs.statSync(path.join(resolveJinnHome(), "org", slug)).isDirectory();
  } catch {
    return false;
  }
}

function definitionWire(slug: string, context: ApiContext): DepartmentDefinitionWire {
  const record = departmentRecord(slug);
  const db = initDb();
  const row = listDepartmentsWithCounts(db).find((candidate) => candidate.slug === slug);
  const extras = record.definition ?? { workdirs: [], skills: [], sharedNotes: [], instructions: "department" as const };
  return {
    slug,
    prefix: row?.prefix ?? null,
    ...fields(record, membersByDepartment(context).get(slug) ?? []),
    workdirs: extras.workdirs,
    skills: extras.skills,
    sharedNotes: extras.sharedNotes,
    instructions: extras.instructions,
    todoCount: row?.todoCount ?? 0,
    spendUsd: departmentSpend(db).get(slug) ?? 0,
    warnings: record.warnings,
  };
}

/** Any directory name the registry reads, minus anything that could leave `org/`. */
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const WRITE_STATUS = { not_found: 404, conflict: 409, invalid: 400 } as const;

/** Nothing enforces a non-open scope yet, so the API will not set one. Opening a department is always allowed; a scoped one is written in the YAML by hand. */
function refuseNonOpenScope(slug: string, scope: DepartmentScope | undefined): void {
  if (scope === undefined || scope === "open") return;
  throw new DepartmentWriteError("invalid", `setting scope: ${scope} through the API is not available yet; write it in org/${slug}/department.yaml`);
}

async function patchDepartment(req: HttpRequest, res: ServerResponse, slug: string, context: ApiContext): Promise<void> {
  const parsed = await readJsonBody(req, res);
  if (!parsed.ok) return;
  if (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body)) return badRequest(res, "update body must be a JSON object");
  try {
    const patch = readDepartmentPatch(parsed.body as Record<string, unknown>);
    refuseNonOpenScope(slug, patch.scope);
    writeDepartmentFile(slug, patch);
  } catch (err) {
    if (!(err instanceof DepartmentWriteError)) throw err;
    return json(res, { error: err.message }, WRITE_STATUS[err.code]);
  }
  // Re-scan org/ before answering, through the gateway's own reload, so its employee list
  // and the clients (`org:changed`) see the write now rather than when the watcher catches
  // up, and the response and the next read never trail it. A context without the hook
  // (some tests) re-scans directly.
  if (context.reloadOrg) context.reloadOrg();
  else refreshOrg(context.getConfig());
  json(res, { department: definitionWire(slug, context) });
}

/** Handles the department routes; `false` leaves the request to api.ts. */
export async function handleDepartmentsApi(req: HttpRequest, res: ServerResponse, route: ParsedRoute, context: ApiContext): Promise<boolean> {
  const { method, pathname } = route;
  if (method === "GET" && pathname === "/api/departments") {
    json(res, { departments: listRows(context) });
    return true;
  }
  const params = matchRoute("/api/departments/:slug", pathname);
  if (!params || (method !== "GET" && method !== "PATCH")) return false;
  if (!SLUG.test(params.slug) || !knownDepartment(params.slug, context)) {
    notFound(res);
    return true;
  }
  if (method === "GET") json(res, { department: definitionWire(params.slug, context) });
  else await patchDepartment(req, res, params.slug, context);
  return true;
}
