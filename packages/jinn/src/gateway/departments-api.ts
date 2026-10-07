import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { initDb } from "../shared/db.js";
import { resolveJinnHome } from "../shared/paths.js";
import { skillRefusal } from "../shared/skill-inspection.js";
import type { DepartmentScope } from "../work-items/department-scope.js";
import { departmentSpend, listDepartmentsWithCounts, type DepartmentSummary } from "../work-items/departments.js";
import { ensureDepartmentRegistered, resolveCompanyPrefix, resolveTodoDepartments } from "../work-items/store.js";
import { isDepartmentArchived, openTodoCount, setDepartmentArchived } from "../work-items/department-archive.js";
import { departmentRecord, departmentSlugsWithFiles, type DepartmentRecord } from "./department-registry.js";
import { DepartmentWriteError, readDepartmentPatch, writeDepartmentFile } from "./department-store.js";
import { readJsonBody } from "./http-helpers.js";
import { strandedByScopeChange, strandingMessage } from "./department-scope/stranding.js";
import { droppedByScopeChange } from "./department-scope/scope-change.js";
import { orgRegistry, refreshOrg } from "./org-registry.js";
import { badRequest, json, matchRoute, notFound, type ParsedRoute } from "./route-helpers.js";
import type { ApiContext } from "./api.js";

/**
 * The department routes.
 *
 *   GET   /api/departments        the registry rows, each with its definition
 *   GET   /api/departments/:slug  one department in full
 *   PATCH /api/departments/:slug  rewrite that department's `department.yaml` (operator only)
 *   POST  /api/departments/:slug/archive    archive it: no new Todos, out of the pickers (operator only)
 *   POST  /api/departments/:slug/unarchive  take it back (operator only)
 *
 * The listing leaves archived departments out unless `?includeArchived=true` asks for them.
 *
 * Writes are operator-only: `control-plane-routes.ts` lists them and api.ts
 * enforces that table before any module is asked. A scope change that would strand a
 * Todo's holder is refused, naming them (FR-015).
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
  /** Instance MCP servers its scoped sessions get beside `jinn`. */
  mcp: string[];
  sharedNotes: string[];
  instructions: "department" | "department+company";
  todoCount: number;
  spendUsd: number;
  archived: boolean;
  archivedAt: string | null;
  /** Entries the scan dropped, each with its reason. */
  warnings: string[];
  /** Skills the allow-list names that the stage directory refuses (a symlink inside one, say), each with why. They are not in `skills`: no session is given them. */
  skillProblems: Array<{ skill: string; reason: string }>;
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

/** The `GET /api/departments` rows; the department-scope gate narrows them to one. */
export function listDepartmentRows(context: ApiContext, { includeArchived = true }: { includeArchived?: boolean } = {}): DepartmentRow[] {
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
  return listDepartmentsWithCounts(initDb(), policy?.allowed).filter((row) => includeArchived || !row.archived).map((row) => ({
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

/** What the registry knows of a department; a department with no row yet has no prefix and no Todos. */
function registryFields(row: DepartmentSummary | undefined): Pick<DepartmentDefinitionWire, "prefix" | "todoCount" | "archived" | "archivedAt"> {
  if (!row) return { prefix: null, todoCount: 0, archived: false, archivedAt: null };
  return { prefix: row.prefix, todoCount: row.todoCount, archived: row.archived, archivedAt: row.archivedAt };
}

function definitionWire(slug: string, context: ApiContext): DepartmentDefinitionWire {
  const record = departmentRecord(slug);
  const db = initDb();
  const row = listDepartmentsWithCounts(db).find((candidate) => candidate.slug === slug);
  const extras = record.definition ?? { workdirs: [], skills: [], mcp: [], sharedNotes: [], instructions: "department" as const };
  // Read from disk on every request: a skill changes while the gateway runs, and the panel should say so now.
  const skillProblems = extras.skills.flatMap((skill) => {
    const reason = skillRefusal(path.join(resolveJinnHome(), "skills", skill));
    return reason ? [{ skill, reason }] : [];
  });
  return {
    slug,
    ...registryFields(row),
    ...fields(record, membersByDepartment(context).get(slug) ?? []),
    workdirs: extras.workdirs,
    skills: extras.skills.filter((skill) => !skillProblems.some((problem) => problem.skill === skill)),
    mcp: extras.mcp,
    sharedNotes: extras.sharedNotes,
    instructions: extras.instructions,
    spendUsd: departmentSpend(db).get(slug) ?? 0,
    warnings: record.warnings,
    skillProblems,
  };
}

/** Any directory name the registry reads, minus anything that could leave `org/`. */
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const WRITE_STATUS = { not_found: 404, conflict: 409, invalid: 400 } as const;

/**
 * Why a scope change is refused, as the 409 body, or null. An employee the next scan would
 * drop from the roster because of the change (FR-007, FR-026) is named, and the change
 * refused, rather than the employee vanishing. FR-015: a change that would leave a
 * Todo with a holder who may no longer hold it is refused naming them.
 */
function scopeChangeRefusal(slug: string, scope: DepartmentScope | undefined, context: ApiContext): Record<string, unknown> | null {
  if (scope === undefined || scope === departmentRecord(slug).scope) return null;
  const members = droppedByScopeChange(slug, scope, orgRegistry(context.getConfig()).values(), context.getConfig().remote);
  if (members.length > 0) {
    const named = members.map((member) => `${member.name} (${member.reason})`).join("; ");
    return { error: `Making ${slug} ${scope} would drop employee(s) from the roster: ${named}. Change them first`, code: "department-members", members };
  }
  const holders = strandedByScopeChange(slug, scope);
  if (holders.length === 0) return null;
  return { error: strandingMessage(`Making ${slug} ${scope}`, holders), code: "department-boundary", holders };
}

async function patchDepartment(req: HttpRequest, res: ServerResponse, slug: string, context: ApiContext): Promise<void> {
  const parsed = await readJsonBody(req, res);
  if (!parsed.ok) return;
  if (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body)) return badRequest(res, "update body must be a JSON object");
  try {
    const patch = readDepartmentPatch(parsed.body as Record<string, unknown>);
    const refused = scopeChangeRefusal(slug, patch.scope, context);
    if (refused) return json(res, refused, 409);
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

/**
 * Why archiving needs the operator to say so again, as the 409 body, or null. A department
 * with members or open Todos keeps both — members can still work its Todos, and those Todos
 * stay open and editable — but nothing new can be filed there, so the operator confirms it
 * knowing who and what is left in it.
 */
function archiveConfirmation(slug: string, context: ApiContext): Record<string, unknown> | null {
  const members = membersByDepartment(context).get(slug) ?? [];
  const openTodos = openTodoCount(initDb(), slug);
  if (members.length === 0 && openTodos === 0) return null;
  const left = [
    ...(members.length > 0 ? [`${members.length} member(s) (${members.join(", ")})`] : []),
    ...(openTodos > 0 ? [`${openTodos} open Todo(s)`] : []),
  ].join(" and ");
  return {
    error: `${slug} still has ${left}. They stay as they are, but nothing new can be filed in ${slug} once it is archived. Send confirm: true to archive it anyway`,
    code: "department-archive-confirm",
    members,
    openTodos,
  };
}

/** Why an archive is refused as asked, as the 409 body, or null. */
function archiveRefusal(slug: string, confirmed: boolean, context: ApiContext): Record<string, unknown> | null {
  if (isDepartmentArchived(initDb(), slug)) return null;
  // Every create that names no department lands in the configured default, so archiving
  // it would refuse them all.
  if (resolveTodoDepartments()?.defaultDepartment === slug) {
    return { error: `${slug} is gateway.todoDepartments.default: change the default before archiving it`, code: "department-default" };
  }
  return confirmed ? null : archiveConfirmation(slug, context);
}

/** The archive body's `confirm`, or null once a 400 has been sent. Empty means no confirmation. */
async function readConfirm(req: HttpRequest, res: ServerResponse): Promise<boolean | null> {
  const parsed = await readJsonBody(req, res, { allowEmpty: true });
  if (!parsed.ok) return null;
  const body = parsed.body ?? {};
  if (typeof body !== "object" || Array.isArray(body)) {
    badRequest(res, "body must be a JSON object");
    return null;
  }
  const { confirm } = body as { confirm?: unknown };
  if (confirm !== undefined && typeof confirm !== "boolean") {
    badRequest(res, "confirm must be a boolean");
    return null;
  }
  return confirm === true;
}

async function archiveDepartment(req: HttpRequest, res: ServerResponse, slug: string, archived: boolean, context: ApiContext): Promise<void> {
  const confirmed = await readConfirm(req, res);
  if (confirmed === null) return;
  const refused = archived ? archiveRefusal(slug, confirmed, context) : null;
  if (refused) return json(res, refused, 409);
  if (setDepartmentArchived(initDb(), slug, archived, resolveCompanyPrefix())) {
    context.emit?.("company:changed", { entity: "department", action: archived ? "archived" : "unarchived", id: slug });
  }
  json(res, { department: definitionWire(slug, context) });
}

/** POST .../archive and .../unarchive; `false` when the path is neither. */
async function handleArchiveRoutes(req: HttpRequest, res: ServerResponse, { method, pathname }: ParsedRoute, context: ApiContext): Promise<boolean> {
  if (method !== "POST") return false;
  const archive = matchRoute("/api/departments/:slug/archive", pathname);
  const target = archive ?? matchRoute("/api/departments/:slug/unarchive", pathname);
  if (!target) return false;
  if (!SLUG.test(target.slug) || !knownDepartment(target.slug, context)) notFound(res);
  else await archiveDepartment(req, res, target.slug, archive !== null, context);
  return true;
}

/** Handles the department routes; `false` leaves the request to api.ts. */
export async function handleDepartmentsApi(req: HttpRequest, res: ServerResponse, route: ParsedRoute, context: ApiContext): Promise<boolean> {
  const { method, pathname } = route;
  if (method === "GET" && pathname === "/api/departments") {
    json(res, { departments: listDepartmentRows(context, { includeArchived: route.url.searchParams.get("includeArchived") === "true" }) });
    return true;
  }
  if (await handleArchiveRoutes(req, res, route, context)) return true;
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
