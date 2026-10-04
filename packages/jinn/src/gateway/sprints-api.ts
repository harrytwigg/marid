import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { readJsonBody } from "./http-helpers.js";
import { badRequest, json, matchRoute, notFound, type ParsedRoute } from "./route-helpers.js";
import { workItemActor, type WorkItemCaller } from "./work-item-arming.js";
import { isTodoId } from "../work-items/id.js";
import { getWorkItem } from "../work-items/store.js";
import type { JinnConfig } from "../shared/types.js";
import { mayOrganiseTags, mayRetagTodo } from "./work-item-standing.js";
import {
  completeSprint,
  createSprint,
  deleteSprint,
  getSprint,
  listSprints,
  setWorkItemSprint,
  SprintError,
  startSprint,
  type Sprint,
  updateSprint,
} from "../work-items/sprints.js";

/**
 * The sprint routes.
 *
 *   GET    /api/sprints                 the registry, with counts (any caller)
 *   POST   /api/sprints                 create a planned sprint
 *   PATCH  /api/sprints/:id             rename, or change goal or dates
 *   POST   /api/sprints/:id/start       start a planned sprint
 *   POST   /api/sprints/:id/complete    close the active one, carrying unfinished work
 *   DELETE /api/sprints/:id             delete a planned sprint
 *   PUT    /api/work-items/:id/sprint   move a top-level Todo into a sprint, or out
 *
 * Planning — every sprint write — takes the standing that creates labels, and
 * moving one Todo the standing that changes its labels: both live in
 * work-item-standing.ts, shared with the label routes.
 *
 * `:id` takes a sprint id or its name. Caller resolution, the manager check and
 * the projection signal arrive as options because api.ts keeps them
 * module-private, and importing them back would close a cycle.
 */

export interface SprintsApiOptions {
  /** api.ts's work-item caller resolution; undefined once it has answered. */
  resolveCaller: () => WorkItemCaller | undefined;
  /** The live config, for the org hierarchy behind the manager check. */
  getConfig: () => JinnConfig;
  /** Tell the live surfaces these Todos' projections changed. */
  emitProjection: (id: string) => void;
  /** Tell them a sprint changed: rows embed their sprint's name and status, so
   *  every write here — lifecycle or move — has to reach other open tabs. */
  emitSprintChange: (action: string, id: string) => void;
}

const SPRINT_FIELDS = ["name", "goal", "startsAt", "endsAt"] as const;

function sprintFailure(res: ServerResponse, err: unknown): void {
  if (err instanceof SprintError) {
    const status = err.code === "not_found" ? 404 : err.code === "conflict" ? 409 : 400;
    json(res, { error: err.message }, status);
    return;
  }
  throw err;
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

/** The sprint fields a body sets: strings, or null to clear (name cannot be). */
function readSprintFields(body: Record<string, unknown>): { ok: true; value: Record<string, string | null> } | { ok: false; error: string } {
  const value: Record<string, string | null> = {};
  for (const key of SPRINT_FIELDS) {
    const v = body[key];
    if (v === undefined) continue;
    if (v === null && key !== "name") {
      value[key] = null;
      continue;
    }
    if (typeof v !== "string") return { ok: false, error: `${key} must be a string${key === "name" ? "" : " or null"}` };
    value[key] = v;
  }
  return { ok: true, value };
}

async function plannerOrAnswer(res: ServerResponse, options: SprintsApiOptions): Promise<WorkItemCaller | undefined> {
  const caller = options.resolveCaller();
  if (!caller) return undefined;
  if (!(await mayOrganiseTags(caller, options.getConfig()))) {
    json(res, { error: "planning sprints requires the operator or a manager (an employee with direct reports)" }, 403);
    return undefined;
  }
  return caller;
}

type Handler = (req: HttpRequest, res: ServerResponse, params: Record<string, string>, options: SprintsApiOptions) => Promise<void>;

/** Run a planning write: answer 403 for a non-planner, map a refusal to its 4xx. */
function plannerWrite(write: (req: HttpRequest, res: ServerResponse, params: Record<string, string>, caller: WorkItemCaller,
  options: SprintsApiOptions) => Promise<void>): Handler {
  return async (req, res, params, options) => {
    const caller = await plannerOrAnswer(res, options);
    if (!caller) return;
    try {
      await write(req, res, params, caller, options);
    } catch (err) {
      sprintFailure(res, err);
    }
  };
}

const listRoute: Handler = async (_req, res) => json(res, { sprints: listSprints() });

const getRoute: Handler = async (_req, res, params) => {
  const sprint = getSprint(params.id);
  if (!sprint) return notFound(res);
  return json(res, { sprint: listSprints().find((s) => s.id === sprint.id) ?? sprint });
};

const createRoute = plannerWrite(async (req, res, _params, _caller, options) => {
  const body = await readObject(req, res);
  if (!body) return;
  const fields = readSprintFields(body);
  if (!fields.ok) return badRequest(res, fields.error);
  if (typeof fields.value.name !== "string") return badRequest(res, "name is required");
  const sprint = createSprint({ ...fields.value, name: fields.value.name });
  options.emitSprintChange("created", sprint.id);
  json(res, { sprint }, 201);
});

const updateRoute = plannerWrite(async (req, res, params, _caller, options) => {
  const body = await readObject(req, res);
  if (!body) return;
  const fields = readSprintFields(body);
  if (!fields.ok) return badRequest(res, fields.error);
  const sprint = updateSprint(params.id, fields.value);
  options.emitSprintChange("updated", sprint.id);
  json(res, { sprint });
});

const startRoute = plannerWrite(async (_req, res, params, _caller, options) => {
  const sprint = startSprint(params.id);
  options.emitSprintChange("started", sprint.id);
  json(res, { sprint });
});

const completeRoute = plannerWrite(async (req, res, params, caller, options) => {
  const body = await readObject(req, res);
  if (!body) return;
  const carryTo = body.carryTo;
  if (carryTo !== null && (typeof carryTo !== "string" || !carryTo.trim())) {
    return badRequest(res, "carryTo is required: a planned sprint's id or name, or null to take unfinished Todos out of any sprint");
  }
  if (body.startNext !== undefined && typeof body.startNext !== "boolean") return badRequest(res, "startNext must be a boolean");
  const result = completeSprint(params.id, { carryTo, startNext: body.startNext === true }, workItemActor(caller), caller.origin);
  for (const id of result.carried) options.emitProjection(id);
  options.emitSprintChange("completed", result.sprint.id);
  json(res, result);
});

const deleteRoute = plannerWrite(async (_req, res, params, caller, options) => {
  const { sprintId, moved } = deleteSprint(params.id, workItemActor(caller), caller.origin);
  for (const id of moved) options.emitProjection(id);
  options.emitSprintChange("deleted", sprintId);
  json(res, { deleted: true, moved });
});

/** The Todo a move acts on, or undefined once the route has answered. */
function movableTodo(res: ServerResponse, id: string, caller: WorkItemCaller) {
  if (!isTodoId(id)) {
    badRequest(res, "Invalid Todo ID; expected <AAA>-N with a positive safe-integer suffix");
    return undefined;
  }
  const item = getWorkItem(id);
  if (!item) {
    notFound(res);
    return undefined;
  }
  if (!mayRetagTodo(caller, item)) {
    json(res, { error: "moving a Todo between sprints requires the operator, the item creator, or the assignee" }, 403);
    return undefined;
  }
  return item;
}

/** The `sprint` a move body names: an id or name, or null for none. */
function readMoveTarget(res: ServerResponse, body: Record<string, unknown>): { ok: true; sprint: string | null } | { ok: false } {
  const sprint = body.sprint;
  if (sprint === null || (typeof sprint === "string" && sprint.trim())) return { ok: true, sprint };
  badRequest(res, "sprint is required: a sprint id or name, or null for no sprint");
  return { ok: false };
}

/** The row shape Todo payloads carry, and the version the move left, so a
 *  caller's next CAS edit does not conflict with its own move. */
function moveResponse(itemId: string, sprint: Sprint | null, fallbackVersion: number): Record<string, unknown> {
  const ref = sprint && { id: sprint.id, name: sprint.name, status: sprint.status };
  return { sprint: ref, version: getWorkItem(itemId)?.version ?? fallbackVersion };
}

const moveRoute: Handler = async (req, res, params, options) => {
  const caller = options.resolveCaller();
  if (!caller) return;
  const item = movableTodo(res, params.id, caller);
  if (!item) return;
  const body = await readObject(req, res);
  if (!body) return;
  const target = readMoveTarget(res, body);
  if (!target.ok) return;
  try {
    const result = setWorkItemSprint(item.id, target.sprint, workItemActor(caller), caller.origin);
    if (result.changed) {
      options.emitProjection(item.id);
      options.emitSprintChange("moved", item.id); // its sub-tasks' rows changed too
    }
    json(res, moveResponse(item.id, result.sprint, item.version));
  } catch (err) {
    sprintFailure(res, err);
  }
};

/** Most specific first: `/api/sprints/:id/:action` before `/api/sprints/:id`. */
const ROUTES: ReadonlyArray<readonly [string, string, Handler]> = [
  ["GET", "/api/sprints", listRoute],
  ["POST", "/api/sprints", createRoute],
  ["PUT", "/api/work-items/:id/sprint", moveRoute],
  ["POST", "/api/sprints/:id/start", startRoute],
  ["POST", "/api/sprints/:id/complete", completeRoute],
  ["GET", "/api/sprints/:id", getRoute],
  ["PATCH", "/api/sprints/:id", updateRoute],
  ["DELETE", "/api/sprints/:id", deleteRoute],
];

export async function handleSprintsApi(
  req: HttpRequest,
  res: ServerResponse,
  route: ParsedRoute,
  options: SprintsApiOptions,
): Promise<boolean> {
  for (const [method, pattern, handler] of ROUTES) {
    if (method !== route.method) continue;
    const params = matchRoute(pattern, route.pathname);
    if (!params) continue;
    await handler(req, res, params, options);
    return true;
  }
  return false;
}
