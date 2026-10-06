import {
  getSession,
  listChildSessions,
  listPinnedSessions,
  listRecentPerGroup,
  listSessions,
  listSessionsForGroup,
  searchMessages,
  searchSessions,
  searchSessionsFiltered,
} from "../../sessions/registry.js";
import type { Session } from "../../shared/types.js";
import { listDepartmentRows } from "../departments-api.js";
import { employeePayload, orgPayload } from "../org-api.js";
import { badRequest, json, notFound } from "../route-helpers.js";
import { messageSearchFilter, sessionSearchFilter } from "../search-api.js";
import { readCleanSearchParam } from "../work-item-query.js";
import { peekJsonObject } from "./body.js";
import { forbid, isMember, type GateRequest } from "./gate.js";
import type { ScopedRouteKind } from "./rules.js";

/**
 * The session, org and department rows of the scoped-caller table (FR-009, FR-012 to
 * FR-014, FR-016). Only sessions bound to D are visible or reachable; the one exception
 * is a live reply to the caller's own requester (FR-013). Org reads show D's members
 * and the department list shows D.
 */

const PER_GROUP = 50;
/** Searches are over-fetched and then narrowed, so a page is rarely short. */
const SEARCH_WINDOW = 500;

const bound = (department: string) => (session: Pick<Session, "scopeDepartment"> | undefined) => session?.scopeDepartment === department;

/** An unknown session is left to the route; one outside D answers as unknown. */
function refuseSessionOutside(g: GateRequest, id: string): boolean {
  const session = getSession(id);
  if (!session || session.scopeDepartment === g.caller.department) return false;
  notFound(g.res);
  return true;
}

/** The page for `?group=`, cut after narrowing so its offset counts only visible rows. */
function groupPage(params: URLSearchParams, group: string, portal: string | undefined, visible: (session: Session) => boolean): Session[] {
  const limit = Math.max(1, parseInt(params.get("limit") || "50", 10) || 50);
  const offset = Math.max(0, parseInt(params.get("offset") || "0", 10) || 0);
  return listSessionsForGroup(group, SEARCH_WINDOW, 0, portal).filter(visible).slice(offset, offset + limit);
}

/** The `?pinned`, `?q`, `?group` and `?limit=0` forms, narrowed; undefined for the default listing. */
function selectedList(params: URLSearchParams, portal: string | undefined, visible: (session: Session) => boolean): Session[] | undefined {
  const query = params.get("q")?.trim();
  const group = params.get("group");
  if (params.get("pinned") === "1") return listPinnedSessions().filter(visible);
  if (query) return searchSessions(query, SEARCH_WINDOW).filter(visible);
  if (group) return groupPage(params, group, portal, visible);
  return params.get("limit") === "0" ? listSessions().filter(visible) : undefined;
}

function groupCounts(sessions: readonly Session[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const session of sessions) {
    if (session.archivedAt) continue;
    const key = session.employee ?? "__direct__";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function serveSessionList(g: GateRequest): boolean {
  const visible = bound(g.caller.department);
  const portal = g.deps.context.getConfig().portal?.portalName;
  const selected = selectedList(g.route.url.searchParams, portal, visible);
  json(g.res, selected ? g.deps.serializeSessions(selected) : {
    sessions: g.deps.serializeSessions(listRecentPerGroup(PER_GROUP, portal).filter(visible)),
    counts: groupCounts(listSessions().filter(visible)),
    perGroup: PER_GROUP,
  });
  return true;
}

function serveSessionSearch(g: GateRequest): boolean {
  const filter = sessionSearchFilter(g.route.url);
  // An unusable or empty filter: the route answers it in its own words.
  if (!filter.ok || Object.keys(filter.value).length === 0) return false;
  const limit = Math.max(1, Math.min(parseInt(g.route.url.searchParams.get("limit") || "20", 10) || 20, 50));
  const sessions = searchSessionsFiltered(filter.value, SEARCH_WINDOW).filter(bound(g.caller.department)).slice(0, limit);
  json(g.res, { sessions: sessions.map(g.deps.compactSessionSummary) });
  return true;
}

function serveMessageSearch(g: GateRequest): boolean {
  const q = readCleanSearchParam(g.route.url, "q");
  if (!q) return false; // the route answers a missing or oversized query in its own words
  const filter = messageSearchFilter(g.route.url);
  if (!filter.ok) return badRequest(g.res, filter.error), true;
  const limit = Math.max(1, Math.min(parseInt(g.route.url.searchParams.get("limit") || "20", 10) || 20, 200));
  const visible = bound(g.caller.department);
  const results = searchMessages(q, SEARCH_WINDOW, filter.value).filter((hit) => visible(getSession(hit.sessionId))).slice(0, limit);
  json(g.res, { query: q, results });
  return true;
}

function serveChildren(g: GateRequest): boolean {
  if (!getSession(g.rule.params.id)) return false;
  if (refuseSessionOutside(g, g.rule.params.id)) return true;
  json(g.res, g.deps.serializeSessions(listChildSessions(g.rule.params.id).filter(bound(g.caller.department))));
  return true;
}

/** FR-013: a live reply to the caller's own requester is the one send outside D. */
function sendInDepartment(g: GateRequest): boolean {
  if (g.rule.params.id === g.caller.session.parentSessionId) return false;
  return refuseSessionOutside(g, g.rule.params.id);
}

async function spawnInDepartment(g: GateRequest): Promise<boolean> {
  const body = await peekJsonObject(g.req, g.res);
  if (!body) return true;
  if (!isMember(body.employee, g.caller.department)) {
    const who = typeof body.employee === "string" && body.employee ? body.employee : "a session with no employee";
    return forbid(g, `${who} is not a member of department "${g.caller.department}"; a department-scoped session can spawn only its own department's members`);
  }
  const parent = typeof body.parentSessionId === "string" ? body.parentSessionId : "";
  if (parent && getSession(parent) && getSession(parent)?.scopeDepartment !== g.caller.department) {
    return badRequest(g.res, `unknown parentSessionId "${parent}"`), true;
  }
  return false;
}

/** An employee row with everyone outside `members` taken out of its reporting edges: a manager outside D is not named. */
function narrowEmployee(view: Record<string, unknown>, members: ReadonlySet<string>): Record<string, unknown> {
  const inside = (name: unknown) => typeof name === "string" && members.has(name);
  const names = (value: unknown) => (Array.isArray(value) ? value.filter(inside) : value);
  const reportsTo = Array.isArray(view.reportsTo) ? view.reportsTo.filter(inside) : inside(view.reportsTo) ? view.reportsTo : undefined;
  return {
    ...view,
    reportsTo: Array.isArray(reportsTo) && reportsTo.length === 0 ? undefined : reportsTo,
    parentName: inside(view.parentName) ? view.parentName : null,
    directReports: names(view.directReports),
    chain: names(view.chain),
  };
}

async function serveOrg(g: GateRequest): Promise<boolean> {
  const payload = await orgPayload(g.deps.context);
  const members = new Set(payload.employees.filter((employee) => isMember(employee.name, g.caller.department)).map((employee) => String(employee.name)));
  json(g.res, {
    departments: [g.caller.department],
    employees: payload.employees.filter((employee) => members.has(String(employee.name))).map((employee) => narrowEmployee(employee, members)),
    hierarchy: {
      root: payload.hierarchy.root && members.has(payload.hierarchy.root) ? payload.hierarchy.root : null,
      sorted: payload.hierarchy.sorted.filter((name) => members.has(name)),
      warnings: [],
    },
  });
  return true;
}

/** One member's row, narrowed as the list is; anyone else answers as unknown. */
async function serveOrgEmployee(g: GateRequest): Promise<boolean> {
  const payload = isMember(g.rule.params.name, g.caller.department) ? await employeePayload(g.rule.params.name, g.deps.context) : null;
  if (!payload) return notFound(g.res), true;
  const roster = (await orgPayload(g.deps.context)).employees.map((employee) => String(employee.name));
  json(g.res, narrowEmployee(payload, new Set(roster.filter((name) => isMember(name, g.caller.department)))));
  return true;
}

const HANDLERS: Partial<Record<ScopedRouteKind, (g: GateRequest) => boolean | Promise<boolean>>> = {
  "sessions-list": serveSessionList,
  "session-search": serveSessionSearch,
  "message-search": serveMessageSearch,
  session: (g) => refuseSessionOutside(g, g.rule.params.id),
  "session-children": serveChildren,
  "session-message": sendInDepartment,
  "own-session": (g) => (g.rule.params.id === g.caller.session.id ? false : forbid(g, "a department-scoped session can publish attachments only to its own session")),
  spawn: spawnInDepartment,
  org: serveOrg,
  "org-employee": serveOrgEmployee,
  departments: (g) => (json(g.res, { departments: listDepartmentRows(g.deps.context).filter((row) => row.slug === g.caller.department) }), true),
};

export const SESSION_KINDS: ReadonlySet<ScopedRouteKind> = new Set(Object.keys(HANDLERS) as ScopedRouteKind[]);

export function handleSessionKind(g: GateRequest): boolean | Promise<boolean> {
  return HANDLERS[g.rule.kind]!(g);
}
