import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { readJsonBody } from "./http-helpers.js";
import { badRequest, json, matchRoute, notFound, type ParsedRoute } from "./route-helpers.js";
import { workItemActor, type WorkItemCaller } from "./work-item-arming.js";
import { isTodoId } from "../work-items/id.js";
import { getWorkItem } from "../work-items/store.js";
import {
  completeSprint,
  createSprint,
  deleteSprint,
  getSprint,
  listSprints,
  setWorkItemSprint,
  SprintError,
  startSprint,
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
 * Planning — every sprint write — is the operator's or a manager's, the same
 * standing that creates labels. Moving one Todo is open to whoever may label it:
 * the operator, its creator, or its assignee.
 *
 * `:id` takes a sprint id or its name. Caller resolution, the manager check and
 * the projection signal arrive as options because api.ts keeps them
 * module-private, and importing them back would close a cycle.
 */

export interface SprintsApiOptions {
  /** api.ts's work-item caller resolution; undefined once it has answered. */
  resolveCaller: () => WorkItemCaller | undefined;
  /** Whether this caller may plan sprints: the operator, or a manager. */
  canPlan: (caller: WorkItemCaller) => Promise<boolean>;
  /** Whether this caller may move this Todo: the label standing. */
  canMove: (caller: WorkItemCaller, item: NonNullable<ReturnType<typeof getWorkItem>>) => boolean;
  /** Tell the live surfaces these Todos' projections changed. */
  emitProjection: (id: string) => void;
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
  if (!(await options.canPlan(caller))) {
    json(res, { error: "planning sprints requires the operator or a manager (an employee with direct reports)" }, 403);
    return undefined;
  }
  return caller;
}

async function handleRegistry(req: HttpRequest, res: ServerResponse, method: string, options: SprintsApiOptions): Promise<void> {
  if (method === "GET") return json(res, { sprints: listSprints() });
  const caller = await plannerOrAnswer(res, options);
  if (!caller) return;
  const body = await readObject(req, res);
  if (!body) return;
  const fields = readSprintFields(body);
  if (!fields.ok) return badRequest(res, fields.error);
  if (typeof fields.value.name !== "string") return badRequest(res, "name is required");
  try {
    const sprint = createSprint({ ...fields.value, name: fields.value.name });
    return json(res, { sprint }, 201);
  } catch (err) {
    return sprintFailure(res, err);
  }
}

async function handleOne(req: HttpRequest, res: ServerResponse, method: string, ref: string, action: string | undefined,
  options: SprintsApiOptions): Promise<void> {
  const caller = await plannerOrAnswer(res, options);
  if (!caller) return;
  try {
    if (method === "PATCH" && !action) {
      const body = await readObject(req, res);
      if (!body) return;
      const fields = readSprintFields(body);
      if (!fields.ok) return badRequest(res, fields.error);
      return json(res, { sprint: updateSprint(ref, fields.value) });
    }
    if (method === "POST" && action === "start") return json(res, { sprint: startSprint(ref) });
    if (method === "POST" && action === "complete") {
      const body = await readObject(req, res);
      if (!body) return;
      const carryTo = body.carryTo;
      if (carryTo !== null && (typeof carryTo !== "string" || !carryTo.trim())) {
        return badRequest(res, "carryTo is required: a planned sprint's id or name, or null to take unfinished Todos out of any sprint");
      }
      if (body.startNext !== undefined && typeof body.startNext !== "boolean") return badRequest(res, "startNext must be a boolean");
      const result = completeSprint(ref, { carryTo, startNext: body.startNext === true }, workItemActor(caller), caller.origin);
      for (const id of result.carried) options.emitProjection(id);
      return json(res, result);
    }
    if (method === "DELETE" && !action) {
      const moved = deleteSprint(ref, workItemActor(caller), caller.origin);
      for (const id of moved) options.emitProjection(id);
      return json(res, { deleted: true, moved });
    }
    return notFound(res);
  } catch (err) {
    return sprintFailure(res, err);
  }
}

async function handleMove(req: HttpRequest, res: ServerResponse, id: string, options: SprintsApiOptions): Promise<void> {
  const caller = options.resolveCaller();
  if (!caller) return;
  if (!isTodoId(id)) return badRequest(res, "Invalid Todo ID; expected <AAA>-N with a positive safe-integer suffix");
  const item = getWorkItem(id);
  if (!item) return notFound(res);
  if (!options.canMove(caller, item)) {
    return json(res, { error: "moving a Todo between sprints requires the operator, the item creator, or the assignee" }, 403);
  }
  const body = await readObject(req, res);
  if (!body) return;
  const sprint = body.sprint;
  if (sprint !== null && (typeof sprint !== "string" || !sprint.trim())) {
    return badRequest(res, "sprint is required: a sprint id or name, or null for no sprint");
  }
  try {
    const result = setWorkItemSprint(id, sprint, workItemActor(caller), caller.origin);
    if (result.changed) options.emitProjection(item.id);
    return json(res, { sprint: result.sprint });
  } catch (err) {
    return sprintFailure(res, err);
  }
}

export async function handleSprintsApi(
  req: HttpRequest,
  res: ServerResponse,
  route: ParsedRoute,
  options: SprintsApiOptions,
): Promise<boolean> {
  const { method, pathname } = route;
  if (pathname === "/api/sprints") {
    if (method !== "GET" && method !== "POST") return false;
    await handleRegistry(req, res, method, options);
    return true;
  }
  const move = matchRoute("/api/work-items/:id/sprint", pathname);
  if (move) {
    if (method !== "PUT") return false;
    await handleMove(req, res, move.id, options);
    return true;
  }
  const withAction = matchRoute("/api/sprints/:id/:action", pathname);
  const bare = withAction ? null : matchRoute("/api/sprints/:id", pathname);
  const params = withAction ?? bare;
  if (!params) return false;
  const action = withAction?.action;
  if (action !== undefined && action !== "start" && action !== "complete") return false;
  if (action === undefined && method !== "PATCH" && method !== "DELETE" && method !== "GET") return false;
  if (action !== undefined && method !== "POST") return false;
  if (method === "GET") {
    const sprint = getSprint(params.id);
    if (!sprint) notFound(res);
    else json(res, { sprint: listSprints().find((s) => s.id === sprint.id) ?? sprint });
    return true;
  }
  await handleOne(req, res, method, params.id, action, options);
  return true;
}
