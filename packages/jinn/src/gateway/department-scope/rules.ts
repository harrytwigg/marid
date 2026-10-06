import { matchRoute } from "../route-helpers.js";

/**
 * The scoped-caller route table (FR-010, plan.md "Scoped-caller route table"): every
 * route a session of a scoped employee may reach, and how the gate holds it to its
 * department D. Anything not listed is refused, so a route added later is closed to
 * scoped sessions until someone classifies it here. The enumeration test
 * (`department-scope-routes.test.ts`) fails on any gateway route that is neither here
 * nor in `REFUSED_ROUTES`, so the classification is a decision, not an accident.
 *
 * The kinds:
 *   todo-list       list/search: narrowed to Todos whose root is in D
 *   todo-trees      batched trees: ids outside D are dropped
 *   todo-create     lands in D whatever it names; a parent outside D reads as unknown
 *   todo-read       one Todo, served here with relations to Todos outside D hidden
 *   todo            any other per-Todo route: the Todo must be in D, else the route's own unknown-id answer
 *   todo-attach     as todo, plus FR-018's path check on a JSON {path} upload
 *   todo-relation   as todo, and the other end must be in D too
 *   todo-sessions   the Todo's sessions: only those bound to D, plus a hidden count
 *   todo-assign     as todo, and the assignee must be a member of D (or @operator)
 *   todo-dispatch   as todo, and the Todo's assignee must be a member of D
 *   dispatch-config as todo, and every skill must be on D's allow-list
 *   delegation      the delegate must be a member of D; a named Todo must be in D
 *   spawn           the employee must be a member of D; a named parent must be bound to D
 *   sessions-list, session-search, message-search
 *                   only sessions bound to D
 *   session         one session: bound to D, else unknown
 *   session-children the session bound to D; children outside D hidden
 *   session-message bound to D, or the caller's own requester (FR-013)
 *   own-session     only the caller's own session
 *   org, org-employee, departments
 *                   only D's members, and only D
 *   knowledge       Notes and knowledge, rooted at D's folder (FR-028)
 *   pass            unchanged (the handler already confines the caller to itself, or the
 *                   route reveals nothing outside D)
 */
export type ScopedRouteKind =
  | "todo-list" | "todo-trees" | "todo-create" | "todo-read" | "todo" | "todo-attach" | "todo-relation"
  | "todo-sessions" | "todo-assign" | "todo-dispatch" | "dispatch-config"
  | "delegation" | "spawn"
  | "sessions-list" | "session-search" | "message-search" | "session" | "session-children" | "session-message" | "own-session"
  | "org" | "org-employee" | "departments" | "knowledge" | "pass";

export interface ScopedRoute {
  method: string;
  route: string;
  kind: ScopedRouteKind;
  /** The route's own body for an unknown Todo, when it is not the plain `Not found`. */
  namedNotFound?: true;
}

const ANY = "*";

function rows(kind: ScopedRouteKind, methods: string[], ...routes: string[]): ScopedRoute[] {
  return routes.flatMap((route) => methods.map((method) => ({ method, route, kind })));
}

export const SCOPED_ROUTES: readonly ScopedRoute[] = [
  ...rows("todo-list", ["GET"], "/api/work-items", "/api/search/work-items"),
  ...rows("todo-trees", ["GET"], "/api/work-items/trees"),
  ...rows("todo-create", ["POST"], "/api/work-items"),
  ...rows("todo-read", ["GET"], "/api/work-items/:id"),
  ...rows("todo", ["PATCH"], "/api/work-items/:id"),
  ...rows("todo", ["POST", "PUT"], "/api/work-items/:id/status"),
  ...rows("todo", ["GET"], "/api/work-items/:id/tree"),
  ...rows("todo", [ANY], "/api/work-items/:id/kept", "/api/work-items/:id/comments", "/api/work-items/:id/comments/:cid", "/api/work-items/:id/attachments/:aid"),
  ...rows("todo", ["PUT"], "/api/work-items/:id/labels"),
  ...rows("todo-attach", ["GET", "POST"], "/api/work-items/:id/attachments"),
  ...rows("todo-relation", ["POST", "DELETE"], "/api/work-items/:id/relations"),
  ...rows("todo-sessions", ["GET"], "/api/work-items/:id/sessions"),
  ...rows("todo-assign", ["POST"], "/api/work-items/:id/assign"),
  { method: "POST", route: "/api/work-items/:id/dispatch", kind: "todo-dispatch", namedNotFound: true },
  { method: "POST", route: "/api/work-items/:id/capture-landing", kind: "todo", namedNotFound: true },
  ...rows("dispatch-config", ["GET", "PUT"], "/api/work-items/:id/dispatch-config"),
  ...rows("delegation", ["POST"], "/api/delegations"),
  ...rows("spawn", ["POST"], "/api/sessions"),
  ...rows("sessions-list", ["GET"], "/api/sessions"),
  ...rows("session-search", ["GET"], "/api/search/sessions"),
  ...rows("message-search", ["GET"], "/api/search/messages"),
  ...rows("session", ["GET"], "/api/sessions/:id", "/api/sessions/:id/messages", "/api/sessions/:id/transcript", "/api/sessions/:id/context"),
  ...rows("session", ["POST"], "/api/sessions/:id/stop"),
  ...rows("session-children", ["GET"], "/api/sessions/:id/children"),
  ...rows("session-message", ["POST"], "/api/sessions/:id/message"),
  ...rows("own-session", ["POST"], "/api/sessions/:id/attachments"),
  ...rows("org", ["GET"], "/api/org"),
  ...rows("org-employee", ["GET"], "/api/org/employees/:name"),
  ...rows("departments", ["GET"], "/api/departments"),
  ...rows("knowledge", ["GET"], "/api/knowledge/search", "/api/knowledge/read", "/api/notes", "/api/notes/read"),
  ...rows("knowledge", ["POST", "PUT"], "/api/notes"),
  // Existing labels can be applied; administration is refused (FR-014).
  ...rows("pass", ["GET"], "/api/labels"),
  // Self-only already: a compaction and a heartbeat act on the caller's own session.
  ...rows("pass", ["POST"], "/api/compactions"),
  ...rows("pass", [ANY], "/api/heartbeats", "/api/heartbeats/:id"),
  // Engine-internal, and nothing in them reaches beyond the caller.
  ...rows("pass", ["GET"], "/api/status", "/api/features"),
  ...rows("pass", ["POST"], "/api/internal/hook"),
];

/**
 * Every other route the gateway serves, refused to scoped callers with the reason
 * (FR-017). Listed only so the enumeration test can tell a refused route from an
 * unclassified one; the gate refuses anything not in `SCOPED_ROUTES` either way.
 * A prefix ends in `*`.
 */
export const REFUSED_ROUTES: Readonly<Record<string, string>> = {
  "/api/config": "company configuration",
  "/api/onboarding": "company configuration",
  "/api/instances*": "company configuration",
  "/api/engines*": "company configuration",
  "/api/engine-limits*": "company limits",
  "/api/auto-dispatch*": "company dispatch",
  "/api/board-walk*": "company dispatch",
  "/api/cron*": "cron",
  "/api/cost/report": "cost",
  "/api/connectors*": "connectors",
  "/api/remote-mcp": "connectors",
  "/api/files*": "local files (FR-018)",
  "/api/search/global": "global search",
  "/api/search*": "global search",
  "/api/skills*": "the skills API",
  "/api/sprints*": "sprint administration",
  "/api/work-items/:id/sprint": "sprint administration",
  "/api/work-items/:id/archive": "archiving",
  "/api/departments/:slug": "department administration",
  "/api/org*": "org administration",
  "/api/plugins*": "plugins",
  "/api/talk*": "talk control",
  "/api/tts": "talk control",
  "/api/stt*": "talk control",
  "/api/terminals*": "terminals",
  "/api/todo-captures*": "the operator's capture inbox",
  "/api/pins*": "the operator's pins",
  "/api/auth*": "authentication",
  "/api/logs": "logs",
  "/api/system/restart": "the gateway itself",
  "/api/callback-deliveries*": "callback recovery",
  "/api/sessions/bulk-delete": "session administration",
  "/api/sessions/:id/queue*": "session administration",
  "/api/sessions/:id/files/:mode": "the operator's file links",
  "/api/sessions/:id/duplicate": "session administration",
  "/api/sessions/:id/archive": "session administration",
  "/api/sessions/:id/unarchive": "session administration",
  "/api/sessions/:id/reset": "session administration",
  "/api/labels*": "label administration",
};

/** A table pattern as a regular expression: `:param` is one segment, a trailing `*` any rest. */
export function routePattern(route: string): RegExp {
  const prefix = route.endsWith("*");
  const body = (prefix ? route.slice(0, -1) : route)
    .split("/")
    .map((segment) => (segment.startsWith(":") ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${body}${prefix ? ".*" : ""}$`);
}

/** The table row for a request, or undefined: refused. */
export function matchScopedRoute(method: string, pathname: string): (ScopedRoute & { params: Record<string, string> }) | undefined {
  for (const row of SCOPED_ROUTES) {
    if (row.method !== ANY && row.method !== method) continue;
    const params = matchRoute(row.route, pathname);
    if (params) return { ...row, params };
  }
  return undefined;
}

/** Why a route is refused, for the 403. */
export function refusedReason(pathname: string): string {
  const hit = Object.entries(REFUSED_ROUTES).find(([route]) => routePattern(route).test(pathname));
  return hit ? hit[1] : "a route not open to department-scoped sessions";
}
