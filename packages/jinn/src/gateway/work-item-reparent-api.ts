import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { readJsonBody } from "./http-helpers.js";
import { badRequest, json, matchRoute, notFound, type ParsedRoute } from "./route-helpers.js";
import { workItemActor, type WorkItemCaller } from "./work-item-arming.js";
import { authorizeWorkItemOwnerManagerOrRoot } from "./work-item-authority.js";
import { isTodoId } from "../work-items/id.js";
import { DepartmentBoundaryError } from "../work-items/department-scope.js";
import { ReparentError, reparentWorkItem } from "../work-items/reparent.js";
import { getWorkItem, type WorkItem } from "../work-items/store.js";

/**
 * PUT /api/work-items/:id/parent  { parentId: <Todo id> | null }
 *
 * Make a Todo a sub-task of another, or detach it to a root; its own sub-tasks
 * move with it. The caller needs the standing that assigns a Todo (its owner,
 * the owner of a Todo above it, a manager over the owner, the org root, the
 * operator) over the Todo itself, and over the new parent when there is one:
 * hanging work under a Todo hands its owner that work's review.
 */

export interface ReparentApiOptions {
  /** api.ts's work-item caller resolution; undefined once it has answered. */
  resolveCaller: () => WorkItemCaller | undefined;
  /** Tell the live surfaces these Todos' projections changed. */
  emitProjection: (id: string) => void;
}

/** The new parent a body names: a Todo id, or null for none. Answers 400 itself. */
async function readParentId(req: HttpRequest, res: ServerResponse): Promise<{ parentId: string | null } | undefined> {
  const parsed = await readJsonBody(req, res);
  if (!parsed.ok) return undefined;
  if (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body)) {
    badRequest(res, "request body must be a JSON object");
    return undefined;
  }
  const requested = (parsed.body as Record<string, unknown>).parentId;
  if (requested === null) return { parentId: null };
  if (typeof requested === "string" && isTodoId(requested.trim())) return { parentId: requested.trim() };
  badRequest(res, "parentId is required: a Todo id to make this a sub-task of it, or null to detach it to a root");
  return undefined;
}

function refuse(res: ServerResponse, err: unknown): void {
  if (err instanceof ReparentError) return json(res, { error: err.message }, err.code === "not_found" ? 404 : err.code === "conflict" ? 409 : 400);
  if (err instanceof DepartmentBoundaryError) return json(res, { error: err.message, code: err.code, holders: err.holders }, 409);
  throw err;
}

/** Standing over the Todo and over its new parent; answers 403 itself. */
function mayReparent(res: ServerResponse, caller: WorkItemCaller, targets: ReadonlyArray<WorkItem | undefined>): boolean {
  for (const target of targets) {
    if (!target) continue;
    const authorized = authorizeWorkItemOwnerManagerOrRoot(caller, target, "reparent");
    if (!authorized.ok) return json(res, { error: authorized.error }, authorized.status), false;
  }
  return true;
}

/** The Todo and its new parent (if any), both standing-checked. Answers every refusal itself. */
async function resolveReparent(
  req: HttpRequest,
  res: ServerResponse,
  caller: WorkItemCaller,
  id: string,
): Promise<{ item: WorkItem; parentId: string | null } | undefined> {
  if (!isTodoId(id)) return badRequest(res, "Invalid Todo ID; expected <AAA>-N with a positive safe-integer suffix"), undefined;
  const item = getWorkItem(id);
  if (!item) return notFound(res), undefined;
  const body = await readParentId(req, res);
  if (!body) return undefined;
  const parent = body.parentId === null ? undefined : getWorkItem(body.parentId);
  if (body.parentId !== null && !parent) return json(res, { error: `parent Todo ${body.parentId} not found` }, 404), undefined;
  return mayReparent(res, caller, [item, parent]) ? { item, parentId: body.parentId } : undefined;
}

export async function handleReparentApi(
  req: HttpRequest,
  res: ServerResponse,
  route: ParsedRoute,
  options: ReparentApiOptions,
): Promise<boolean> {
  const params = route.method === "PUT" ? matchRoute("/api/work-items/:id/parent", route.pathname) : null;
  if (!params) return false;
  const caller = options.resolveCaller();
  const target = caller && (await resolveReparent(req, res, caller, params.id));
  if (!caller || !target) return true;
  try {
    const result = reparentWorkItem(target.item.id, target.parentId, { actor: workItemActor(caller), origin: caller.origin });
    if (result.changed) for (const id of [...result.moved, ...result.parents]) options.emitProjection(id);
    const { id, parentId, rootId, depth, version } = result.item;
    json(res, { id, parentId, rootId, depth, version, changed: result.changed, moved: result.moved });
  } catch (err) {
    refuse(res, err);
  }
  return true;
}
