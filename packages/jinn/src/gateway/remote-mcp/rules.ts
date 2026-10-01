import type { ServerResponse } from "node:http";
import { getSession } from "../../sessions/registry.js";
import { isRemoteMcpSession } from "../../sessions/remote-mcp-session.js";
import type { Session } from "../../shared/types.js";
import type { WorkItemCaller } from "../work-item-arming.js";
import { json, matchRoute } from "../route-helpers.js";
import type { CallerIdentity } from "../session-comm-guards.js";

/**
 * Gateway-side rules for the remote MCP connector principal
 * (specs/004 FR-011). The connector's tool profile is filtered in `profile.ts`,
 * but a filter is one mistake from exposing a route; these rules make the
 * gateway itself refuse the connector anything outside that profile, so the
 * profile holds even if the anchor's capability ever leaked.
 *
 * FR-013a's ledger restrictions (non-startable Todos, own-Todo-only edits and
 * links, a Notes sandbox, unforwarded comments) were lifted by a later amendment: the
 * connector is the operator's privileged convenience door, and the operator
 * does those things from the web UI unrestricted.
 */

/** Every (method, route) the profile's tools call — and nothing else. The
 *  profile test drives each profile tool against a recording fetch and fails
 *  if one calls a route missing here, so this list cannot drift silently. */
const ALLOWED_ROUTES: ReadonlyArray<readonly [string, string]> = [
  ["GET", "/api/work-items"], ["GET", "/api/work-items/:id"], ["GET", "/api/work-items/:id/tree"],
  ["GET", "/api/work-items/:id/comments"], ["GET", "/api/work-items/:id/attachments"],
  ["GET", "/api/search/work-items"], ["GET", "/api/departments"], ["GET", "/api/labels"],
  ["GET", "/api/sessions"], ["GET", "/api/sessions/:id/children"], ["GET", "/api/search/sessions"],
  ["GET", "/api/org"], ["GET", "/api/org/employees/:name"],
  ["GET", "/api/notes"], ["GET", "/api/notes/read"], ["GET", "/api/knowledge/search"],
  ["GET", "/api/cron"], ["GET", "/api/cron/:id/runs"], ["GET", "/api/cost/report"],
  ["GET", "/api/heartbeats"],
  ["GET", "/api/files"], ["GET", "/api/files/read"],
  // Class L writes.
  ["POST", "/api/work-items"], ["PATCH", "/api/work-items/:id"], ["POST", "/api/work-items/:id/comments"],
  ["PUT", "/api/work-items/:id/labels"], ["POST", "/api/work-items/:id/relations"],
  ["DELETE", "/api/work-items/:id/relations"], ["POST", "/api/notes"], ["PUT", "/api/notes"],
  // Session control.
  ["GET", "/api/sessions/:id"], ["POST", "/api/sessions/:id/message"], ["POST", "/api/delegations"],
  ["POST", "/api/work-items/:id/assign"],
  // The operator lane: close, cancel, reopen and archive.
  ["POST", "/api/work-items/:id/status"], ["POST", "/api/work-items/:id/archive"],
];

export function remoteMcpRouteAllowed(method: string, pathname: string): boolean {
  return ALLOWED_ROUTES.some(([allowedMethod, route]) => allowedMethod === method && matchRoute(route, pathname) !== null);
}

/** The connector session behind a resolved caller identity, if it is one. */
export function remoteMcpCallerSession(identity: CallerIdentity): Session | undefined {
  if (identity.kind !== "session") return undefined;
  const session = getSession(identity.callerId);
  return session && isRemoteMcpSession(session) ? session : undefined;
}

/** Answers 403 and returns true when a connector caller asks for a route outside its profile. */
export function refuseRemoteMcpRoute(res: ServerResponse, method: string, pathname: string, identity: CallerIdentity): boolean {
  if (!remoteMcpCallerSession(identity) || remoteMcpRouteAllowed(method, pathname)) return false;
  json(res, { error: `${method} ${pathname} is outside the remote MCP connector's tool profile` }, 403);
  return true;
}

/**
 * the connector is the operator's own door, so on a Todo it stands where
 * the operator stands — it may assign, label or unlink any Todo, not only the ones
 * it created. What guards it is the bridge (Access JWT, allow-list, cut-off) and
 * the route list above, not a narrower ledger standing. Approval authority is
 * deliberately not part of this: those gates stay the operator surface's.
 */
export function remoteMcpHasOperatorStanding(caller: WorkItemCaller): boolean {
  return caller.kind === "session" && isRemoteMcpSession(caller.session);
}
