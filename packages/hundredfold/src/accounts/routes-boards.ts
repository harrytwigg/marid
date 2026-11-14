import { json, notFound } from "../gateway/route-helpers.js";
import { initialsOf } from "./initials.js";
import {
  BOARD_ROLES, getGrant, isBoardRole, listGrantsForBoard, removeGrant, upsertGrant,
} from "./board-members.js";
import { INVITE_TTL_MS, getTokenById, issueToken, listPendingInvites, revokeOpenInvites, revokeToken, tokenState } from "./tokens.js";
import { requestOrigin } from "./origin.js";
import { getUserByEmail, getUserById, normalizeEmail } from "./users.js";
import { inviteView, readObjectBody, type AccountRouteContext } from "./routes-common.js";
import { runOperatorRoutes, type OperatorRoute } from "./routes-table.js";

/**
 * Who is changing a board's sharing: the operator, or a board owner. The two use the same handlers; an owner is
 * held to a few more rules (never above their own role, never another owner, never an instance owner).
 */
export type BoardShareActor = { kind: "operator" } | { kind: "member"; userId: string };

const grantedBy = (actor: BoardShareActor): string => (actor.kind === "member" ? `user:${actor.userId}` : "operator");

/** What an owner may not do to someone: touch an instance owner, or change another board owner. False once the 403 is written. */
function ownerMayTouch(ctx: AccountRouteContext, actor: BoardShareActor, target: { userId: string; instanceRole: string; boardRole?: string }): boolean {
  if (actor.kind === "operator") return true;
  if (target.instanceRole === "owner") {
    json(ctx.res, { error: "Only the operator can change an instance owner" }, 403);
    return false;
  }
  if (target.boardRole === "owner" && target.userId !== actor.userId) {
    json(ctx.res, { error: "Only the operator can change another board owner" }, 403);
    return false;
  }
  return true;
}

/** `{ members, invites }`: the shape the web reads for the operator's Share dialog and its member mirror alike. */
export function membersAndInvites(ctx: AccountRouteContext, department: string): void {
  const db = ctx.rt.getDb();
  const members = listGrantsForBoard(db, department).flatMap((grant) => {
    const user = getUserById(db, grant.userId);
    if (!user) return [];
    return [{ userId: user.id, displayName: user.displayName, email: user.email, initials: initialsOf(user.displayName), role: grant.role }];
  });
  json(ctx.res, { members, invites: listPendingInvites(db, { department, now: ctx.rt.now() }).map(inviteView) });
}

export async function inviteToBoard(ctx: AccountRouteContext, department: string, actor: BoardShareActor = { kind: "operator" }): Promise<void> {
  const body = await readObjectBody(ctx);
  if (!body) return;
  const email = normalizeEmail(body.email);
  if (!email) return json(ctx.res, { error: "A valid email address is required" }, 400);
  if (!isBoardRole(body.role)) return json(ctx.res, { error: `role must be one of ${BOARD_ROLES.join(", ")}` }, 400);
  const db = ctx.rt.getDb();
  const existing = getUserByEmail(db, email);
  if (existing) {
    if (existing.status !== "active") return json(ctx.res, { error: "That person's account is disabled" }, 409);
    const current = getGrant(db, existing.id, department);
    if (!ownerMayTouch(ctx, actor, { userId: existing.id, instanceRole: existing.instanceRole, boardRole: current?.role })) return;
    // An active account is added straight to the board: there is no link to hand over.
    const grant = upsertGrant(db, { userId: existing.id, department, role: body.role, grantedBy: grantedBy(actor), now: ctx.rt.now() });
    return json(ctx.res, { granted: true, user: { id: existing.id, email: existing.email, displayName: existing.displayName }, role: grant.role });
  }
  revokeOpenInvites(db, email, department, ctx.rt.now());
  const { token, record } = issueToken(db, {
    purpose: "invite", email, department, role: body.role, createdBy: grantedBy(actor), ttlMs: INVITE_TTL_MS, now: ctx.rt.now(),
  });
  const origin = requestOrigin(ctx.req);
  json(ctx.res, { granted: false, invite: inviteView(record), link: origin ? `${origin}/invite#${token}` : null, expiresAt: record.expiresAt });
}

export function revokeBoardInvite(ctx: AccountRouteContext, department: string, id: string): void {
  const db = ctx.rt.getDb();
  const record = getTokenById(db, id);
  if (!record || record.purpose !== "invite" || record.department !== department
    || tokenState(record, ctx.rt.now()) !== "valid" || !revokeToken(db, id, ctx.rt.now())) return notFound(ctx.res);
  json(ctx.res, { status: "ok" });
}

export async function changeRole(ctx: AccountRouteContext, department: string, userId: string, actor: BoardShareActor = { kind: "operator" }): Promise<void> {
  const body = await readObjectBody(ctx);
  if (!body) return;
  if (!isBoardRole(body.role)) return json(ctx.res, { error: `role must be one of ${BOARD_ROLES.join(", ")}` }, 400);
  const db = ctx.rt.getDb();
  const current = getGrant(db, userId, department);
  const target = current ? getUserById(db, userId) : undefined;
  if (!current || !target) return notFound(ctx.res);
  if (!ownerMayTouch(ctx, actor, { userId, instanceRole: target.instanceRole, boardRole: current.role })) return;
  const grant = upsertGrant(db, { userId, department, role: body.role, grantedBy: grantedBy(actor), now: ctx.rt.now() });
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

export function removeMember(ctx: AccountRouteContext, department: string, userId: string, actor: BoardShareActor = { kind: "operator" }): void {
  const db = ctx.rt.getDb();
  const current = getGrant(db, userId, department);
  const target = current ? getUserById(db, userId) : undefined;
  if (!current || !target) return notFound(ctx.res);
  if (!ownerMayTouch(ctx, actor, { userId, instanceRole: target.instanceRole, boardRole: current.role })) return;
  removeGrant(db, userId, department);
  json(ctx.res, { status: "ok" });
}

/** `/api/boards/:department/{members,invites}`, operator only. True when the request was answered. */
export function handleBoardsRoute(ctx: AccountRouteContext): Promise<boolean> {
  return runOperatorRoutes(ROUTES, ctx);
}
