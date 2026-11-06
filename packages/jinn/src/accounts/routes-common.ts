import type { IncomingMessage, ServerResponse } from "node:http";
import { json } from "../gateway/route-helpers.js";
import { readJsonBody } from "../gateway/http-helpers.js";
import type { ParsedRoute } from "../gateway/route-helpers.js";
import { HashBusyError, hashPassword } from "./passwords.js";
import type { AccountsRuntime } from "./runtime.js";
import type { TokenRecord } from "./tokens.js";
import { getUserById } from "./users.js";

export const ACCOUNTS_NEED_AUTH =
  "Accounts need gateway authentication. Turn on gateway auth (gateway.authRequired) before creating or using accounts.";

/** Small bodies only: nothing an account endpoint takes is large. */
export const ACCOUNT_BODY_MAX_BYTES = 16 * 1024;

export interface AccountsApiDeps {
  accounts: AccountsRuntime | undefined;
  /** True for the operator (bearer token or a valid device), false for a capability-bound employee session. */
  isOperator(req: IncomingMessage): boolean;
  /** Writes the refusal and returns true when the caller is a capability-bound employee session. */
  rejectIdentityGrant(req: IncomingMessage, res: ServerResponse, action: string): boolean;
}

export interface AccountRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  route: ParsedRoute;
  rt: AccountsRuntime;
  deps: AccountsApiDeps;
}

/** Account endpoints other than reading state refuse where every browser is the operator. */
export function refuseWithoutGatewayAuth(rt: AccountsRuntime, res: ServerResponse): boolean {
  if (rt.authRequired()) return false;
  json(res, { error: ACCOUNTS_NEED_AUTH }, 403);
  return true;
}

export function requireOperator(ctx: AccountRouteContext): boolean {
  if (refuseWithoutGatewayAuth(ctx.rt, ctx.res)) return false;
  if (ctx.deps.isOperator(ctx.req)) return true;
  json(ctx.res, { error: "Only the operator can manage accounts" }, 403);
  return false;
}

/** A JSON object body, or undefined once the 400 has been written. */
export async function readObjectBody(ctx: AccountRouteContext): Promise<Record<string, unknown> | undefined> {
  const parsed = await readJsonBody(ctx.req, ctx.res, { maxBytes: ACCOUNT_BODY_MAX_BYTES });
  if (!parsed.ok) return undefined;
  if (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body)) {
    json(ctx.res, { error: "Expected a JSON object" }, 400);
    return undefined;
  }
  return parsed.body as Record<string, unknown>;
}

export function clientIp(req: IncomingMessage): string | undefined {
  return req.socket.remoteAddress;
}

export function tooManyRequests(res: ServerResponse, retryAfterSeconds: number, message = "Too many attempts, try again later"): void {
  res.setHeader("Retry-After", String(retryAfterSeconds));
  json(res, { error: message }, 429);
}

export function answerHashBusy(res: ServerResponse, err: unknown): boolean {
  if (!(err instanceof HashBusyError)) return false;
  tooManyRequests(res, err.retryAfterSeconds, "The gateway is busy checking passwords, try again shortly");
  return true;
}

export interface InviteView {
  id: string;
  email: string;
  department: string | null;
  role: string | null;
  instanceRole: string | null;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
}

export const inviteView = (token: TokenRecord): InviteView => ({
  id: token.id, email: token.email, department: token.department, role: token.role, instanceRole: token.instanceRole,
  createdBy: token.createdBy, createdAt: token.createdAt, expiresAt: token.expiresAt,
});

/** Who made an invite, as a person can read it: a user's name, or "Operator". */
export function describeActor(rt: AccountsRuntime, actor: string): string {
  if (!actor.startsWith("user:")) return "Operator";
  return getUserById(rt.getDb(), actor.slice("user:".length))?.displayName ?? "Former member";
}

/** Hash a new password under the global cap; undefined once a 429 has been written because the gateway is busy. */
export async function hashOrBusy(ctx: AccountRouteContext, password: string): Promise<string | undefined> {
  try {
    return await hashPassword(password, ctx.rt.limiter);
  } catch (err) {
    if (answerHashBusy(ctx.res, err)) return undefined;
    throw err;
  }
}
