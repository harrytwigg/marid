import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { readJsonBody } from "./http-helpers.js";
import { badRequest, json, matchRoute, notFound, type ParsedRoute } from "./route-helpers.js";
import { readWriteOrigin, WRITE_ORIGIN_HEADER } from "../work-items/origin.js";
import { isTodoId } from "../work-items/id.js";
import { getWorkItem } from "../work-items/store.js";
import {
  ProjectError,
  projectSpend,
  projectTodoCounts,
  setWorkItemProject,
  type ProjectRef,
} from "../work-items/project-membership.js";
import type { Project } from "./project-model.js";
import { getProject, projectRefOf, readProjects, refreshProjects } from "./project-registry.js";
import { createProject, ProjectWriteError, readProjectInput, updateProject } from "./project-store.js";
import type { ApiContext } from "./api.js";

/**
 * The project routes.
 *
 *   GET   /api/projects                 every project, with live counts
 *   GET   /api/projects/:id             one project
 *   POST  /api/projects                 write a new project file (operator only)
 *   PATCH /api/projects/:id             rewrite that project's file (operator only)
 *   PUT   /api/work-items/:id/project   move a top-level Todo into a project, or out (operator only)
 *
 * Writes are operator-only: `control-plane-routes.ts` lists them and api.ts
 * enforces that table before any module is asked. Nothing here restricts what an
 * employee can see or do; projects only group Todos in this phase.
 */

export type ProjectWire = ProjectRef & {
  description: string;
  dedicated: boolean;
  instructions: Project["instructions"];
  workdirs: string[];
  skills: string[];
  sharedNotes: string[];
  /** Employees scoped to the project. Always empty until employees can be scoped. */
  members: string[];
  todoCount: number;
  spendUsd: number;
  /** The defining YAML file, relative to the instance home. */
  file: string;
  /** Things worth a look, e.g. an id that was previously used under another name. */
  notices: string[];
};

/** A project as the wire carries it. Counts are read live, once per call. */
function wires(projects: Project[]): ProjectWire[] {
  const counts = projectTodoCounts();
  const spend = projectSpend();
  const notices = readProjects().notices;
  return projects.map((project) => ({
    ...projectRefOf(project.id),
    description: project.description,
    dedicated: project.dedicated,
    instructions: project.instructions,
    workdirs: project.workdirs,
    skills: project.skills,
    sharedNotes: project.sharedNotes,
    members: [],
    todoCount: counts.get(project.id) ?? 0,
    spendUsd: spend.get(project.id) ?? 0,
    file: project.file,
    notices: notices.get(project.id) ?? [],
  }));
}

async function readObject(req: HttpRequest, res: ServerResponse): Promise<Record<string, unknown> | undefined> {
  const parsed = await readJsonBody(req, res);
  if (!parsed.ok) return undefined;
  if (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body)) {
    badRequest(res, "request body must be a JSON object");
    return undefined;
  }
  return parsed.body as Record<string, unknown>;
}

function failure(res: ServerResponse, err: unknown): void {
  if (err instanceof ProjectWriteError || err instanceof ProjectError) {
    const status = err.code === "not_found" ? 404 : err.code === "conflict" ? 409 : 400;
    json(res, { error: err.message }, status);
    return;
  }
  throw err;
}

type Handler = (req: HttpRequest, res: ServerResponse, params: Record<string, string>, context: ApiContext) => Promise<void>;

const listRoute: Handler = async (_req, res) => json(res, { projects: wires(refreshProjects().projects) });

const getRoute: Handler = async (_req, res, params) => {
  const project = getProject(params.id);
  if (!project) return notFound(res);
  return json(res, { project: wires([project])[0] });
};

const createRoute: Handler = async (req, res, _params, context) => {
  const body = await readObject(req, res);
  if (!body) return;
  try {
    const project = createProject(readProjectInput(body));
    context.emit("company:changed", { entity: "project", action: "created", id: project.id });
    json(res, { project: wires([project])[0] }, 201);
  } catch (err) {
    failure(res, err);
  }
};

const updateRoute: Handler = async (req, res, params, context) => {
  const body = await readObject(req, res);
  if (!body) return;
  try {
    const project = updateProject(params.id, readProjectInput(body));
    context.emit("company:changed", { entity: "project", action: "updated", id: project.id });
    json(res, { project: wires([project])[0] });
  } catch (err) {
    failure(res, err);
  }
};

/** The `project` a move body names: a project id, or null for none. */
function readMoveTarget(body: Record<string, unknown>): { ok: true; project: string | null } | { ok: false } {
  const project = body.project;
  if (project === null || (typeof project === "string" && project.trim())) return { ok: true, project: project === null ? null : project.trim() };
  return { ok: false };
}

const moveRoute: Handler = async (req, res, params, context) => {
  if (!isTodoId(params.id)) return badRequest(res, "Invalid Todo ID; expected <AAA>-N with a positive safe-integer suffix");
  const item = getWorkItem(params.id);
  if (!item) return notFound(res);
  const body = await readObject(req, res);
  if (!body) return;
  const target = readMoveTarget(body);
  if (!target.ok) return badRequest(res, "project is required: a project id, or null for no project");
  try {
    const result = setWorkItemProject(item.id, target.project, "operator", projectRefOf, readWriteOrigin(req.headers[WRITE_ORIGIN_HEADER]));
    if (result.changed) context.emit("company:changed", { entity: "project", action: "moved", id: item.id });
    json(res, { project: result.project === null ? null : projectRefOf(result.project), version: getWorkItem(item.id)?.version ?? item.version });
  } catch (err) {
    failure(res, err);
  }
};

/** Most specific first. */
const ROUTES: ReadonlyArray<readonly [string, string, Handler]> = [
  ["GET", "/api/projects", listRoute],
  ["POST", "/api/projects", createRoute],
  ["PUT", "/api/work-items/:id/project", moveRoute],
  ["GET", "/api/projects/:id", getRoute],
  ["PATCH", "/api/projects/:id", updateRoute],
];

export async function handleProjectsApi(req: HttpRequest, res: ServerResponse, route: ParsedRoute, context: ApiContext): Promise<boolean> {
  for (const [method, pattern, handler] of ROUTES) {
    if (method !== route.method) continue;
    const params = matchRoute(pattern, route.pathname);
    if (!params) continue;
    await handler(req, res, params, context);
    return true;
  }
  return false;
}
