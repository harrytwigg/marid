import type { IncomingMessage, ServerResponse } from "node:http";
import type { JinnConfig } from "../shared/types.js";
import { json, notFound } from "../gateway/route-helpers.js";
import { readJsonBody } from "../gateway/http-helpers.js";
import { parseRequestAuthority } from "../gateway/request-authority.js";
import { clearUserCookieHeader } from "./cookie.js";
import { publicUser } from "./users.js";
import { revokeUserSession } from "./user-sessions.js";
import type { AccountsRuntime, MemberPrincipal } from "./runtime.js";
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

export interface MemberRouterDeps {
  accounts: AccountsRuntime;
  getConfig: () => Pick<JinnConfig, "gateway">;
  gatewayAuthToken: string | undefined;
  home: string;
}

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

/** `/api/member/*`: only `GET /api/member/me` exists in this phase. */
function memberApi(res: ServerResponse, method: string, pathname: string, principal: MemberPrincipal, deps: MemberRouterDeps): void {
  if (method !== "GET" || pathname !== "/api/member/me") return notFound(res);
  const { email, id, displayName } = publicUser(principal.user);
  json(res, {
    user: { id, email, displayName },
    boards: deps.accounts.boardsOf(principal.userId).map((grant) => ({ department: grant.department, role: grant.role })),
  });
}

/**
 * Everything a signed-in member can reach over HTTP. A member request never enters the general API
 * dispatcher, so members are default-deny by construction: a route added there tomorrow is closed to
 * them until it is deliberately added here.
 *
 * The allowlist is exactly `/api/member/*`, `GET /api/auth/state` and `POST /api/auth/logout`. This
 * phase mounts only `GET /api/member/me`; the rest of `/api/member/*` answers 404 until the member API lands.
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
  if (pathname.startsWith("/api/member/")) return memberApi(res, method, pathname, principal, deps);
  json(res, { error: NOT_AVAILABLE_TO_MEMBERS }, 403);
}
