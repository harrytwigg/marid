import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { readJsonBody } from "./http-helpers.js";
import { badRequest, json, matchRoute, notFound, type ParsedRoute } from "./route-helpers.js";
import { workItemActor, type WorkItemCaller } from "./work-item-arming.js";
import { authorizeAssignOverSubTasks, authorizeWorkItemOwnerManagerOrRoot } from "./work-item-authority.js";
import { isTodoId } from "../work-items/id.js";
import { DepartmentBoundaryError } from "../work-items/department-scope.js";
import { DepartmentArchivedError } from "../work-items/department-archive.js";
import { ReparentError, reparentWorkItem } from "../work-items/reparent.js";
import { getSession } from "../sessions/registry.js";
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
 * need only one end, so an employee's detach can be undone without the operator:
 * the employee who detached a Todo putting it back under the parent it left, and
 * that parent's owner taking back an unassigned Todo detached from it. A Todo the
 * operator detached, or that was never under the parent, needs both ends.
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

/** Where an orphaned Todo came from and who cut it loose: its latest detach, if it has no parent now. */
function lastDetach(item: WorkItem): { from: string; actor: string | null } | undefined {
  if (item.parentId !== null) return undefined;
  for (const event of [...listWorkItemEvents(item.id)].reverse()) {
    const moved = (event.detail as { reparented?: { from?: unknown; to?: unknown } } | null | undefined)?.reparented;
    if (!moved || !("to" in moved) || moved.to !== null) continue;
    return typeof moved.from === "string" ? { from: moved.from, actor: event.actor } : undefined;
  }
  return undefined;
}

/** The employee behind a recorded `session:<id>` actor; undefined for the operator or a session that is gone. */
function detacherEmployee(actor: string | null): string | undefined {
  const id = actor?.startsWith("session:") ? actor.slice("session:".length) : undefined;
  return id ? getSession(id)?.employee ?? undefined : undefined;
}

type Standing = ReturnType<typeof authorizeWorkItemOwnerManagerOrRoot>;

/** The employee who last detached `item` from exactly `parentId`, if it has no parent since. */
function detachedFromBy(item: WorkItem, parentId: string): string | undefined {
  const detach = lastDetach(item);
  return detach?.from === parentId ? detacherEmployee(detach.actor) : undefined;
}

/**
 * The two attaches that need standing over one end only, both undoing a detach
 * the operator did not make: the employee who detached a Todo putting it back
 * under the parent it left, and that parent's owner taking back an unassigned Todo
 * that was detached from it (who must also be able to hold what sits below it).
 * Undefined when neither applies; a refusal says which standing is missing.
 */
function oneEndAttach(caller: WorkItemCaller, item: WorkItem, parent: WorkItem, overItem: Standing, overParent: Standing): Standing | undefined {
  const detacher = detachedFromBy(item, parent.id);
  if (!detacher) return undefined;
  if (overItem.ok && caller.kind === "session" && caller.session.employee === detacher) return overItem;
  return overParent.ok && !item.assignee ? authorizeAssignOverSubTasks(caller, item, "assign") : undefined;
}

/** Standing over the Todo and over its new parent, or one of the narrower
 *  re-attaches. A detach (no parent) needs the Todo only, and asking for the
 *  parent the Todo already has moves nothing. */
function reparentStanding(caller: WorkItemCaller, item: WorkItem, parent: WorkItem | undefined): Standing {
  const overItem = authorizeWorkItemOwnerManagerOrRoot(caller, item, "reparent");
  if (!parent || (overItem.ok && item.parentId === parent.id)) return overItem;
  const overParent = authorizeWorkItemOwnerManagerOrRoot(caller, parent, "reparent");
  if (overItem.ok && overParent.ok) return overItem;
  return oneEndAttach(caller, item, parent, overItem, overParent) ?? (overItem.ok ? overParent : overItem);
}

/** Whether the caller may re-parent; answers 403 itself. */
function mayReparent(res: ServerResponse, caller: WorkItemCaller, item: WorkItem, parent: WorkItem | undefined): boolean {
  const standing = reparentStanding(caller, item, parent);
  if (!standing.ok) json(res, { error: standing.error }, standing.status);
  return standing.ok;
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
