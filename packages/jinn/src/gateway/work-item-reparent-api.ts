import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { readJsonBody } from "./http-helpers.js";
import { badRequest, json, matchRoute, notFound, type ParsedRoute } from "./route-helpers.js";
import { workItemActor, type WorkItemCaller } from "./work-item-arming.js";
import { authorizeAssignOverSubTasks, authorizeWorkItemOwnerManagerOrRoot } from "./work-item-authority.js";
import { isTodoId } from "../work-items/id.js";
import { DepartmentBoundaryError } from "../work-items/department-scope.js";
import { DepartmentArchivedError } from "../work-items/department-archive.js";
import { ReparentError, reparentWorkItem } from "../work-items/reparent.js";
import { listWorkItemEvents } from "../work-items/event-log.js";
import { getWorkItem, type WorkItem } from "../work-items/store.js";

/**
 * PUT /api/work-items/:id/parent  { parentId: <Todo id> | null }
 *
 * Make a Todo a sub-task of another, or detach it to a root; its own sub-tasks
 * move with it. The caller needs the standing that assigns a Todo (its owner,
 * the owner of a Todo above it, a manager over the owner, the org root, the
 * operator) over the Todo itself, and over the new parent when there is one:
 * hanging work under a Todo hands its owner that work's review. Two attaches
 * need only one end, so a detach can always be undone without the operator:
 * putting a detached Todo back under the parent it left (its owner already took
 * that review once), and a parent's owner taking in a root Todo nobody is
 * assigned to.
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
  if (err instanceof DepartmentArchivedError) return json(res, { error: err.message, code: "todo_department_archived", department: err.department }, 409);
  throw err;
}

/** Whether `item` was last detached from exactly `parentId` and has no parent since. */
function wasDetachedFrom(item: WorkItem, parentId: string): boolean {
  if (item.parentId !== null) return false;
  for (const event of [...listWorkItemEvents(item.id)].reverse()) {
    const moved = (event.detail as { reparented?: { from?: unknown; to?: unknown } } | null | undefined)?.reparented;
    if (!moved || !("to" in moved) || moved.to !== null) continue;
    return moved.from === parentId;
  }
  return false;
}

type Standing = ReturnType<typeof authorizeWorkItemOwnerManagerOrRoot>;

/** The two attaches that need standing over one end only. */
function mayAttachWithOneEnd(caller: WorkItemCaller, item: WorkItem, parent: WorkItem, overItem: Standing, overParent: Standing): boolean {
  // Put back where it came from: the caller may edit the Todo, and its parent's owner already held it.
  if (overItem.ok && wasDetachedFrom(item, parent.id)) return true;
  // A parent's owner taking in a root nobody is assigned to; it must also be able to hold what sits below it.
  return overParent.ok && !item.assignee && item.parentId === null && authorizeAssignOverSubTasks(caller, item, "assign").ok;
}

/** Standing over the Todo and over its new parent, or one of the two narrower
 *  attaches; answers 403 itself. A detach (no parent) needs the Todo only. */
function mayReparent(res: ServerResponse, caller: WorkItemCaller, item: WorkItem, parent: WorkItem | undefined): boolean {
  const overItem = authorizeWorkItemOwnerManagerOrRoot(caller, item, "reparent");
  const overParent: Standing = parent ? authorizeWorkItemOwnerManagerOrRoot(caller, parent, "reparent") : { ok: true };
  if (overItem.ok && overParent.ok) return true;
  if (parent && mayAttachWithOneEnd(caller, item, parent, overItem, overParent)) return true;
  const refusal = overItem.ok ? overParent : overItem;
  if (!refusal.ok) json(res, { error: refusal.error }, refusal.status);
  return false;
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
  return mayReparent(res, caller, item, parent) ? { item, parentId: body.parentId } : undefined;
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
