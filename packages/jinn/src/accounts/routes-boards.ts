import { json, notFound } from "../gateway/route-helpers.js";
import {
  BOARD_ROLES, getGrant, isBoardRole, listGrantsForBoard, removeGrant, upsertGrant,
} from "./board-members.js";
import { INVITE_TTL_MS, getTokenById, issueToken, listPendingInvites, revokeOpenInvites, revokeToken, tokenState } from "./tokens.js";
import { requestOrigin } from "./origin.js";
import { getUserByEmail, getUserById, normalizeEmail, publicUser } from "./users.js";
import { inviteView, readObjectBody, type AccountRouteContext } from "./routes-common.js";
import { runOperatorRoutes, type OperatorRoute } from "./routes-table.js";

function membersAndInvites(ctx: AccountRouteContext, department: string): void {
  const db = ctx.rt.getDb();
  const members = listGrantsForBoard(db, department).flatMap((grant) => {
    const user = getUserById(db, grant.userId);
    if (!user) return [];
    const { id, email, displayName, status } = publicUser(user);
    return [{ user: { id, email, displayName, status }, role: grant.role, grantedBy: grant.grantedBy, grantedAt: grant.grantedAt }];
  });
  json(ctx.res, { department, members, invites: listPendingInvites(db, { department, now: ctx.rt.now() }).map(inviteView) });
}

async function inviteToBoard(ctx: AccountRouteContext, department: string): Promise<void> {
  const body = await readObjectBody(ctx);
  if (!body) return;
  const email = normalizeEmail(body.email);
  if (!email) return json(ctx.res, { error: "A valid email address is required" }, 400);
  if (!isBoardRole(body.role)) return json(ctx.res, { error: `role must be one of ${BOARD_ROLES.join(", ")}` }, 400);
  const db = ctx.rt.getDb();
  const existing = getUserByEmail(db, email);
  if (existing) {
    if (existing.status !== "active") return json(ctx.res, { error: "That person's account is disabled" }, 409);
    // An active account is added straight to the board: there is no link to hand over.
    const grant = upsertGrant(db, { userId: existing.id, department, role: body.role, grantedBy: "operator", now: ctx.rt.now() });
    return json(ctx.res, { granted: true, user: { id: existing.id, email: existing.email, displayName: existing.displayName }, role: grant.role });
  }
  revokeOpenInvites(db, email, department, ctx.rt.now());
  const { token, record } = issueToken(db, {
    purpose: "invite", email, department, role: body.role, createdBy: "operator", ttlMs: INVITE_TTL_MS, now: ctx.rt.now(),
  });
  const origin = requestOrigin(ctx.req);
  json(ctx.res, { granted: false, invite: inviteView(record), link: origin ? `${origin}/invite#${token}` : null });
}

function revokeBoardInvite(ctx: AccountRouteContext, department: string, id: string): void {
  const db = ctx.rt.getDb();
  const record = getTokenById(db, id);
  if (!record || record.purpose !== "invite" || record.department !== department
    || tokenState(record, ctx.rt.now()) !== "valid" || !revokeToken(db, id, ctx.rt.now())) return notFound(ctx.res);
  json(ctx.res, { status: "ok" });
}

async function changeRole(ctx: AccountRouteContext, department: string, userId: string): Promise<void> {
  const body = await readObjectBody(ctx);
  if (!body) return;
  if (!isBoardRole(body.role)) return json(ctx.res, { error: `role must be one of ${BOARD_ROLES.join(", ")}` }, 400);
  const db = ctx.rt.getDb();
  if (!getGrant(db, userId, department)) return notFound(ctx.res);
  const grant = upsertGrant(db, { userId, department, role: body.role, grantedBy: "operator", now: ctx.rt.now() });
  json(ctx.res, { status: "ok", role: grant.role });
}

/** A board route: the board must exist before anything else is said about it. */
const onBoard = (run: (ctx: AccountRouteContext, department: string, params: Record<string, string>) => void | Promise<void>): OperatorRoute["run"] =>
  (ctx, params) => (ctx.rt.departmentExists(params.department!) ? run(ctx, params.department!, params) : notFound(ctx.res));

const ROUTES: readonly OperatorRoute[] = [
  { method: "GET", pattern: "/api/boards/:department/members", run: onBoard((ctx, department) => membersAndInvites(ctx, department)) },
  { method: "POST", pattern: "/api/boards/:department/invites", run: onBoard((ctx, department) => inviteToBoard(ctx, department)) },
  { method: "DELETE", pattern: "/api/boards/:department/invites/:id", run: onBoard((ctx, department, params) => revokeBoardInvite(ctx, department, params.id!)) },
  { method: "PATCH", pattern: "/api/boards/:department/members/:userId", run: onBoard((ctx, department, params) => changeRole(ctx, department, params.userId!)) },
  { method: "DELETE", pattern: "/api/boards/:department/members/:userId", run: onBoard((ctx, department, params) => removeMember(ctx, department, params.userId!)) },
];

function removeMember(ctx: AccountRouteContext, department: string, userId: string): void {
  if (removeGrant(ctx.rt.getDb(), userId, department)) json(ctx.res, { status: "ok" });
  else notFound(ctx.res);
}

/** `/api/boards/:department/{members,invites}`, operator only. True when the request was answered. */
export function handleBoardsRoute(ctx: AccountRouteContext): Promise<boolean> {
  return runOperatorRoutes(ROUTES, ctx);
}
