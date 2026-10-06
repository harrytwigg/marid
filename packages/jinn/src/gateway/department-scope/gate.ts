import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import type { Session } from "../../shared/types.js";
import { getSession } from "../../sessions/registry.js";
import { departmentPathRefusal, insideDepartmentRoots } from "../../shared/department-file-roots.js";
import { isTodoId } from "../../work-items/id.js";
import { OPERATOR_ASSIGNEE } from "../../work-items/operator-assignee.js";
import { getWorkItem, type WorkItem } from "../../work-items/store.js";
import { employeeDepartment } from "../../work-items/department-scope.js";
import type { ApiContext } from "../api.js";
import { departmentRecord } from "../department-registry.js";
import { badRequest, json, type ParsedRoute } from "../route-helpers.js";
import type { SessionTreeResponse } from "../../sessions/session-tree.js";
import type { CallerIdentity } from "../session-comm-guards.js";
import { peekJsonObject, setPeekedBody } from "./body.js";
import { resolveScopedCaller, type ScopedCaller } from "./caller.js";
import { departmentFileRoots } from "./paths.js";
import { serveTodoRead, serveTodoSessions } from "./todo-reads.js";
import { matchScopedRoute, refusedReason, type ScopedRoute, type ScopedRouteKind } from "./rules.js";
import { handleSessionKind, SESSION_KINDS } from "./session-routes.js";
import { handleKnowledgeRoute } from "./knowledge-routes.js";

/**
 * The scoped-caller gate (FR-010 to FR-019). One call in `handleApiRequest`, beside the
 * remote MCP connector's: every request from a session of a scoped employee is held to
 * its department D here, before any handler runs. No handler is edited for scoping:
 * a route the table passes runs as it always has, on a request the gate has checked
 * and, for a few reads, narrowed; a route it serves itself answers from the same
 * stores with the out-of-department rows removed.
 *
 * Out-of-department ids answer exactly as unknown ones do, so a scoped session cannot
 * tell a Todo or session it may not see from one that does not exist.
 */

export interface ScopedGateDeps {
  context: ApiContext;
  /** api.ts's live serialisation of a session list. */
  serializeSessions: (sessions: readonly Session[]) => Session[];
  /** The reference-layer session summary the search routes answer with. */
  compactSessionSummary: (session: Session) => Record<string, unknown>;
  /** The Todo page's session tree, with runtime activity, as the route builds it. */
  readSessionTree: (todoId: string) => SessionTreeResponse;
}

export interface GateRequest {
  req: HttpRequest;
  res: ServerResponse;
  route: ParsedRoute;
  caller: ScopedCaller;
  rule: ScopedRoute & { params: Record<string, string> };
  deps: ScopedGateDeps;
}

/** The department a Todo's scope is decided by: its root's (FR-002). */
export function scopeDepartmentOfTodo(item: WorkItem): string | null {
  if (item.rootId === item.id) return item.department;
  return getWorkItem(item.rootId)?.department ?? item.department;
}

export function todoInDepartment(id: string, department: string): boolean {
  const item = isTodoId(id) ? getWorkItem(id) : undefined;
  return !!item && scopeDepartmentOfTodo(item) === department;
}

export function isMember(employee: unknown, department: string): boolean {
  return typeof employee === "string" && employeeDepartment(employee.trim()) === department;
}

/** A well-formed Todo id with `id`'s prefix that no Todo will ever have (the allocator counts up from 1). */
function unknownTodoLike(id: string): string {
  return `${id.slice(0, id.lastIndexOf("-"))}-${Number.MAX_SAFE_INTEGER}`;
}

/**
 * Hold a per-Todo route to D. A Todo outside D is presented to the route as an unknown
 * one: the gate rewrites the id in the path to one that cannot exist, so the route
 * answers exactly as it does for an unknown id, whatever it checks first (its caller's
 * standing, a precondition, an empty list). A route whose unknown-id answer names the
 * id is answered here instead, with the real id. Returns true when the gate answered,
 * false when the route should run now on the hidden id, and null for a Todo in D (or
 * an unknown or malformed id, which the route answers itself), so the row's own checks
 * go on.
 */
export function holdTodo(g: GateRequest, id: string): boolean | null {
  if (!isTodoId(id)) return null;
  const item = getWorkItem(id);
  if (!item || scopeDepartmentOfTodo(item) === g.caller.department) return null;
  if (g.rule.namedNotFound) return json(g.res, { error: `Todo ${id} not found` }, 404), true;
  const parts = g.route.url.pathname.split("/");
  parts[3] = unknownTodoLike(id);
  g.route.url.pathname = parts.join("/");
  return false;
}

export function forbid(g: GateRequest, message: string): true {
  json(g.res, { error: `${message} (this session is scoped to department "${g.caller.department}")` }, 403);
  return true;
}

function memberRefusal(g: GateRequest, who: unknown, action: string): true {
  return forbid(g, `${typeof who === "string" && who ? who : "an employee outside the roster"} is not a member of department "${g.caller.department}"; a department-scoped session can ${action} only its own department's members`);
}

/** Narrow a Todo list or search to D's Todos (by root), and drop ids outside D. */
function narrowTodoList(g: GateRequest, emptyBody: Record<string, unknown>): boolean {
  const params = g.route.url.searchParams;
  const rawIds = params.get("ids");
  if (rawIds !== null && rawIds.trim()) {
    const kept = rawIds.split(",").map((id) => id.trim()).filter((id) => !isTodoId(id) || todoInDepartment(id, g.caller.department));
    if (kept.length === 0) return json(g.res, emptyBody), true;
    params.set("ids", kept.join(","));
  }
  params.set("rootDepartment", g.caller.department);
  return false;
}

async function createInDepartment(g: GateRequest): Promise<boolean> {
  const body = await peekJsonObject(g.req, g.res);
  if (!body) return true;
  if (body.sprint !== undefined) return forbid(g, "sprints are the operator's; a department-scoped session cannot place a Todo in one");
  const parentId = namedTodoOutside(body.parentId, g.caller.department);
  if (parentId) return badRequest(g.res, `parent Todo ${parentId} not found`), true;
  setPeekedBody(g.req, { ...body, department: g.caller.department });
  return false;
}

async function attachInDepartment(g: GateRequest): Promise<boolean> {
  const held = holdTodo(g, g.rule.params.id);
  if (held !== null) return held;
  if (g.route.method !== "POST" || !String(g.req.headers["content-type"] ?? "").includes("application/json")) return false;
  const body = await peekJsonObject(g.req, g.res);
  if (!body) return true;
  if (typeof body.path !== "string") return false;
  const roots = departmentFileRoots(g.caller.department);
  return insideDepartmentRoots(body.path, roots) ? false : forbid(g, departmentPathRefusal(body.path, roots));
}

async function relateInDepartment(g: GateRequest): Promise<boolean> {
  const held = holdTodo(g, g.rule.params.id);
  if (held !== null) return held;
  const body = await peekJsonObject(g.req, g.res);
  if (!body) return true;
  // The other end, too, reads as unknown to the route.
  const other = namedTodoOutside(body.dstId, g.caller.department);
  if (other) setPeekedBody(g.req, { ...body, dstId: unknownTodoLike(other) });
  return false;
}

async function assignInDepartment(g: GateRequest): Promise<boolean> {
  const held = holdTodo(g, g.rule.params.id);
  if (held !== null) return held;
  const body = await peekJsonObject(g.req, g.res);
  if (!body) return true;
  const assignee = typeof body.assignee === "string" ? body.assignee.trim() : body.assignee;
  if (assignee === OPERATOR_ASSIGNEE || isMember(assignee, g.caller.department)) return false;
  return memberRefusal(g, assignee, "assign Todos to");
}

function dispatchInDepartment(g: GateRequest): boolean {
  const held = holdTodo(g, g.rule.params.id);
  if (held !== null) return held;
  const item = isTodoId(g.rule.params.id) ? getWorkItem(g.rule.params.id) : undefined;
  if (!item || isMember(item.assignee, g.caller.department)) return false;
  if (!item.assignee) return forbid(g, `${item.id} has no assignee; assign it to a member of the department before dispatching it`);
  return memberRefusal(g, item.assignee, "dispatch work to");
}

async function dispatchConfigInDepartment(g: GateRequest): Promise<boolean> {
  const held = holdTodo(g, g.rule.params.id);
  if (held !== null) return held;
  const body = await peekJsonObject(g.req, g.res);
  if (!body) return true;
  const allowed = new Set(departmentRecord(g.caller.department).definition?.skills ?? []);
  const skills = Array.isArray(body.skills) ? body.skills : [];
  const refused = skills.filter((skill) => typeof skill === "string" && !allowed.has(skill));
  if (refused.length === 0) return false;
  return forbid(g, `skill(s) ${refused.join(", ")} are not on department "${g.caller.department}"'s skill allow-list`);
}

/** A Todo id the body names that exists outside D; unknown and malformed ids are the route's to answer. */
function namedTodoOutside(value: unknown, department: string): string | null {
  const id = typeof value === "string" ? value.trim() : "";
  return id && isTodoId(id) && getWorkItem(id) && !todoInDepartment(id, department) ? id : null;
}

/** A parent the body names that exists outside D reads as unknown: the route then uses the caller itself. */
function dropParentOutside(g: GateRequest, body: Record<string, unknown>): void {
  const parent = typeof body.parentSessionId === "string" ? getSession(body.parentSessionId) : undefined;
  if (!parent || parent.scopeDepartment === g.caller.department) return;
  const { parentSessionId: _dropped, ...rest } = body;
  setPeekedBody(g.req, rest);
}

async function delegateInDepartment(g: GateRequest): Promise<boolean> {
  const body = await peekJsonObject(g.req, g.res);
  if (!body) return true;
  if (!isMember(body.employee, g.caller.department)) return memberRefusal(g, body.employee, "delegate to");
  const outside = namedTodoOutside(body.workItemId, g.caller.department);
  if (outside) return json(g.res, { error: `Todo ${outside} not found` }, 404), true;
  dropParentOutside(g, body);
  return false;
}

type KindHandler = (g: GateRequest) => boolean | Promise<boolean>;

const TODO_KINDS: Partial<Record<ScopedRouteKind, KindHandler>> = {
  "todo-list": (g) => narrowTodoList(g, { workItems: [] }),
  "todo-trees": (g) => narrowTodoList(g, { trees: {} }),
  "todo-create": createInDepartment,
  "todo-read": (g) => holdTodo(g, g.rule.params.id) ?? serveTodoRead(g),
  "todo": (g) => holdTodo(g, g.rule.params.id) ?? false,
  "todo-attach": attachInDepartment,
  "todo-relation": relateInDepartment,
  "todo-sessions": (g) => holdTodo(g, g.rule.params.id) ?? serveTodoSessions(g),
  "todo-assign": assignInDepartment,
  "todo-dispatch": dispatchInDepartment,
  "dispatch-config": dispatchConfigInDepartment,
  "delegation": delegateInDepartment,
  "knowledge": handleKnowledgeRoute,
  "pass": () => false,
};

/** A lost binding still reads its own transcript; nothing else. */
function ownTranscriptRoute(method: string, pathname: string, sessionId: string): boolean {
  if (method !== "GET") return false;
  const own = `/api/sessions/${encodeURIComponent(sessionId)}`;
  return pathname === own || pathname === `${own}/messages` || pathname === `${own}/transcript`;
}

/**
 * Hold a scoped caller's request to its department. Returns true when the gate has
 * answered (a refusal, or a read it serves itself); false lets the route run, on the
 * request as the gate checked and narrowed it. Unscoped callers return false at once.
 */
export async function handleScopedCaller(
  req: HttpRequest,
  res: ServerResponse,
  route: ParsedRoute,
  identity: CallerIdentity,
  deps: ScopedGateDeps,
): Promise<boolean> {
  const caller = resolveScopedCaller(identity);
  if (!caller) return false;
  const { method, pathname } = route;
  if (caller.lost) {
    if (ownTranscriptRoute(method, pathname, caller.session.id)) return false;
    json(res, { error: `This department-scoped session cannot act: ${caller.lost}` }, 403);
    return true;
  }
  const rule = matchScopedRoute(method, pathname);
  if (!rule) {
    json(res, { error: `${method} ${pathname} is not available to a department-scoped session: ${refusedReason(pathname)} is outside department "${caller.department}"` }, 403);
    return true;
  }
  const g: GateRequest = { req, res, route, caller, rule, deps };
  const handler = TODO_KINDS[rule.kind];
  if (handler) return handler(g);
  if (SESSION_KINDS.has(rule.kind)) return handleSessionKind(g);
  return forbid(g, `${method} ${pathname} is not classified for department-scoped sessions`);
}
