import type { IncomingMessage, ServerResponse } from "node:http";
import { json, notFound } from "../gateway/route-helpers.js";
import { readJsonBody } from "../gateway/http-helpers.js";
import { parseRequestAuthority } from "../gateway/request-authority.js";
import { clearUserCookieHeader } from "./cookie.js";
import { revokeUserSession } from "./user-sessions.js";
import type { MemberPrincipal } from "./runtime.js";
import type { MemberRouterDeps } from "./member-context.js";
import { runMemberRoutes } from "./member-routes.js";
import { buildAuthState } from "./state.js";

export const NOT_AVAILABLE_TO_MEMBERS = "Not available to board members";

const BODY_MAX_BYTES = 16 * 1024;

/**
 * Whether a member may open this socket path. Exactly `/ws`: not `/ws/pty/*`, not a plugin's event stream,
 * not anything else.
 */
export function memberMayUpgrade(requestUrl: string): boolean {
  return requestUrl === "/ws";
}

/** True when this request line is one the general dispatcher would take (the one place that rule lives). */
export function isApiTarget(requestUrl: string): boolean {
  return requestUrl.startsWith("/api/");
}

export type { MemberRouterDeps } from "./member-context.js";

/** The request line, checked as the general dispatcher checks it before it parses anything; undefined once a 400 is written. */
function parseTarget(req: IncomingMessage, res: ServerResponse): { method: string; pathname: string } | undefined {
  if (!parseRequestAuthority(req)) return void json(res, { error: "Invalid request authority" }, 400);
  const rawTarget = req.url || "/";
  if (!rawTarget.startsWith("/") || rawTarget.startsWith("//") || /[\x00-\x1f\\]/.test(rawTarget)) {
    return void json(res, { error: "Invalid request target" }, 400);
  }
  try {
    return { method: req.method || "GET", pathname: new URL(rawTarget, "http://localhost").pathname };
  } catch {
    return void json(res, { error: "Invalid request target" }, 400);
  }
}

async function logout(req: IncomingMessage, res: ServerResponse, principal: MemberPrincipal, deps: MemberRouterDeps): Promise<void> {
  const parsed = await readJsonBody(req, res, { allowEmpty: true, maxBytes: BODY_MAX_BYTES });
  if (!parsed.ok) return;
  revokeUserSession(deps.accounts.getDb(), principal.sessionId, deps.accounts.now());
  res.setHeader("Set-Cookie", clearUserCookieHeader(deps.home));
  json(res, { status: "ok" });
}

/**
 * Everything a signed-in member can reach over HTTP. A member request never enters the general API
 * dispatcher, so members are default-deny by construction: a route added there tomorrow is closed to
 * them until it is deliberately added here.
 *
 * The allowlist is exactly `/api/member/*`, `GET /api/auth/state` and `POST /api/auth/logout`. Inside
 * `/api/member/*` only the routes in `member-routes.ts` exist; any other path answers 404.
 */
export async function handleMemberRequest(
  req: IncomingMessage,
  res: ServerResponse,
  principal: MemberPrincipal,
  deps: MemberRouterDeps,
): Promise<void> {
  const target = parseTarget(req, res);
  if (!target) return;
  const { method, pathname } = target;
  if (method === "GET" && pathname === "/api/auth/state") {
    return json(res, buildAuthState(deps.getConfig(), req, deps.gatewayAuthToken, deps.home, deps.accounts));
  }
  if (method === "POST" && pathname === "/api/auth/logout") return logout(req, res, principal, deps);
  if (pathname.startsWith("/api/member/")) {
    const route = { method, pathname, url: new URL(req.url || "/", "http://localhost") };
    if (!(await runMemberRoutes({ req, res, principal, deps }, route))) notFound(res);
    return;
  }
  json(res, { error: NOT_AVAILABLE_TO_MEMBERS }, 403);
}
