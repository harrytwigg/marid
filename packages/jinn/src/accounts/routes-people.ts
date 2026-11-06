import { clearAuthCookieHeaders, currentAuthDeviceId, listAuthSessionsForUser, revokeAuthSession, revokeAuthSessionsForUser } from "../gateway/auth.js";
import { json, notFound } from "../gateway/route-helpers.js";
import { listGrantsForUser } from "./board-members.js";
import { initialsOf } from "./initials.js";
import {
  INVITE_TTL_MS, OWNER_INVITE_TTL_MS, RESET_TTL_MS, getTokenById, issueToken, listPendingInvites, revokeOpenInvites,
  revokeOpenResets, revokeToken, tokenState,
} from "./tokens.js";
import { requestOrigin } from "./origin.js";
import {
  getUserSession, listUserSessions, revokeUserSession, revokeUserSessionsForUser, notifyUserSessionsRevoked,
} from "./user-sessions.js";
import {
  deleteUser, getUserByEmail, getUserById, listUsers, normalizeDisplayName, normalizeEmail, publicUser, updateUser,
  type UserPatch, type UserRecord,
} from "./users.js";
import { inviteView, readObjectBody, type AccountRouteContext } from "./routes-common.js";
import { runOperatorRoutes, type OperatorRoute } from "./routes-table.js";

/** The latest time this person was seen on any session: a member session or an operator device their password minted. */
function lastSeenAt(ctx: AccountRouteContext, userId: string): string | null {
  const seen = [
    ...listUserSessions(ctx.rt.getDb(), userId, ctx.rt.now()).map((session) => session.lastSeenAt),
    ...listAuthSessionsForUser(ctx.rt.home, userId).map((device) => device.lastSeenAt),
  ].filter((at): at is string => typeof at === "string" && at.length > 0);
  return seen.length > 0 ? seen.reduce((latest, at) => (at > latest ? at : latest)) : null;
}

function personView(ctx: AccountRouteContext, user: UserRecord) {
  return {
    ...publicUser(user),
    initials: initialsOf(user.displayName),
    passwordSet: user.passwordHash !== null,
    lastSeenAt: lastSeenAt(ctx, user.id),
    boards: listGrantsForUser(ctx.rt.getDb(), user.id).map((grant) => ({ department: grant.department, role: grant.role })),
  };
}

function listPeople(ctx: AccountRouteContext): void {
  json(ctx.res, { people: listUsers(ctx.rt.getDb()).map((user) => personView(ctx, user)) });
}

/** Everything that lets this user act: member sessions and the operator devices their password minted. */
function revokeEverything(ctx: AccountRouteContext, userId: string): number {
  const members = revokeUserSessionsForUser(ctx.rt.getDb(), userId, { now: ctx.rt.now() });
  return members + revokeAuthSessionsForUser(ctx.rt.home, userId);
}

function parsePatch(body: Record<string, unknown>): UserPatch | string {
  const patch: UserPatch = {};
  if (body.displayName !== undefined) {
    const name = normalizeDisplayName(body.displayName);
    if (!name) return "Display name must be 1 to 80 characters";
    patch.displayName = name;
  }
  if (body.status !== undefined) {
    if (body.status !== "active" && body.status !== "disabled") return "status must be active or disabled";
    patch.status = body.status;
  }
  if (body.instanceRole !== undefined) {
    if (body.instanceRole !== "member" && body.instanceRole !== "owner") return "instanceRole must be member or owner";
    patch.instanceRole = body.instanceRole;
  }
  return Object.keys(patch).length > 0 ? patch : "Nothing to change: send displayName, status or instanceRole";
}

async function patchPerson(ctx: AccountRouteContext, id: string): Promise<void> {
  const body = await readObjectBody(ctx);
  if (!body) return;
  const existing = getUserById(ctx.rt.getDb(), id);
  if (!existing) return notFound(ctx.res);
  const patch = parsePatch(body);
  if (typeof patch === "string") return json(ctx.res, { error: patch }, 400);
  const updated = updateUser(ctx.rt.getDb(), id, patch, ctx.rt.now())!;
  const disabled = patch.status === "disabled" && existing.status !== "disabled";
  const demoted = patch.instanceRole === "member" && existing.instanceRole === "owner";
  const promoted = patch.instanceRole === "owner" && existing.instanceRole !== "owner";
  // Disabling ends every session; demoting an owner ends the operator devices their password minted, and
  // promoting a member ends their member sessions so the next sign-in is the operator one.
  if (disabled) revokeEverything(ctx, id);
  else if (demoted) revokeAuthSessionsForUser(ctx.rt.home, id);
  else if (promoted) revokeUserSessionsForUser(ctx.rt.getDb(), id, { now: ctx.rt.now() });
  json(ctx.res, { person: personView(ctx, updated) });
}

function removePerson(ctx: AccountRouteContext, id: string): void {
  if (!getUserById(ctx.rt.getDb(), id)) return notFound(ctx.res);
  revokeAuthSessionsForUser(ctx.rt.home, id);
  deleteUser(ctx.rt.getDb(), id);
  notifyUserSessionsRevoked();
  json(ctx.res, { status: "ok" });
}

function issueResetLink(ctx: AccountRouteContext, id: string): void {
  const db = ctx.rt.getDb();
  const user = getUserById(db, id);
  if (!user) return notFound(ctx.res);
  revokeOpenResets(db, user.id, ctx.rt.now());
  const { token, record } = issueToken(db, {
    purpose: "reset", email: user.email, userId: user.id, createdBy: "operator", ttlMs: RESET_TTL_MS, now: ctx.rt.now(),
  });
  const origin = requestOrigin(ctx.req);
  json(ctx.res, { link: origin ? `${origin}/reset#${token}` : null, expiresAt: record.expiresAt });
}

function sessionViews(ctx: AccountRouteContext, userId: string): unknown[] {
  const members = listUserSessions(ctx.rt.getDb(), userId, ctx.rt.now()).map((session) => ({
    id: session.id, kind: "member", createdAt: session.createdAt, lastSeenAt: session.lastSeenAt, expiresAt: session.expiresAt,
    userAgent: session.userAgent, ip: session.ip,
  }));
  const devices = listAuthSessionsForUser(ctx.rt.home, userId).map((device) => ({
    id: device.id, kind: "device", name: device.name, createdAt: device.createdAt, lastSeenAt: device.lastSeenAt,
    userAgent: device.userAgent ?? null, ip: device.lastIp ?? null,
  }));
  return [...members, ...devices];
}

function revokeOneSession(ctx: AccountRouteContext, userId: string, sessionId: string): void {
  const db = ctx.rt.getDb();
  if (sessionId.startsWith("uss_")) {
    const session = getUserSession(db, sessionId);
    if (!session || session.userId !== userId || !revokeUserSession(db, sessionId, ctx.rt.now())) return notFound(ctx.res);
    return json(ctx.res, { status: "ok" });
  }
  const device = listAuthSessionsForUser(ctx.rt.home, userId).find((candidate) => candidate.id === sessionId);
  if (!device || !revokeAuthSession(ctx.rt.home, sessionId)) return notFound(ctx.res);
  const current = currentAuthDeviceId(ctx.req.headers, ctx.rt.home) === sessionId;
  if (current) ctx.res.setHeader("Set-Cookie", clearAuthCookieHeaders(ctx.rt.home));
  json(ctx.res, { status: "ok", current });
}

async function createInstanceInvite(ctx: AccountRouteContext): Promise<void> {
  const body = await readObjectBody(ctx);
  if (!body) return;
  const email = normalizeEmail(body.email);
  if (!email) return json(ctx.res, { error: "A valid email address is required" }, 400);
  const instanceRole = body.instanceRole ?? "member";
  if (instanceRole !== "member" && instanceRole !== "owner") return json(ctx.res, { error: "instanceRole must be member or owner" }, 400);
  const db = ctx.rt.getDb();
  if (getUserByEmail(db, email)) {
    return json(ctx.res, { error: "That email already has an account. Change its instance role instead." }, 409);
  }
  revokeOpenInvites(db, email, null, ctx.rt.now());
  const { token, record } = issueToken(db, {
    purpose: "invite", email, instanceRole, createdBy: "operator", now: ctx.rt.now(),
    ttlMs: instanceRole === "owner" ? OWNER_INVITE_TTL_MS : INVITE_TTL_MS,
  });
  const origin = requestOrigin(ctx.req);
  json(ctx.res, { invite: inviteView(record), link: origin ? `${origin}/invite#${token}` : null, expiresAt: record.expiresAt });
}

function revokeInvite(ctx: AccountRouteContext, id: string): void {
  const db = ctx.rt.getDb();
  const record = getTokenById(db, id);
  if (!record || record.purpose !== "invite" || tokenState(record, ctx.rt.now()) !== "valid" || !revokeToken(db, id, ctx.rt.now())) {
    return notFound(ctx.res);
  }
  json(ctx.res, { status: "ok" });
}

const idOf = (params: Record<string, string>): string => params.id!;

function showPerson(ctx: AccountRouteContext, params: Record<string, string>): void {
  const user = getUserById(ctx.rt.getDb(), idOf(params));
  if (user) json(ctx.res, { person: personView(ctx, user) });
  else notFound(ctx.res);
}

/** A route that names a person: 404 for one who does not exist, before anything else. */
const forPerson = (run: (ctx: AccountRouteContext, params: Record<string, string>) => void | Promise<void>): OperatorRoute["run"] =>
  (ctx, params) => (getUserById(ctx.rt.getDb(), idOf(params)) ? run(ctx, params) : notFound(ctx.res));

// Literal paths first: `/api/people/invites` must not be read as a person called "invites".
const ROUTES: readonly OperatorRoute[] = [
  { method: "GET", pattern: "/api/people", run: listPeople },
  { method: "GET", pattern: "/api/people/invites", run: (ctx) => json(ctx.res, { invites: listPendingInvites(ctx.rt.getDb(), { now: ctx.rt.now() }).map(inviteView) }) },
  { method: "POST", pattern: "/api/people/invites", run: createInstanceInvite },
  { method: "DELETE", pattern: "/api/people/invites/:id", run: (ctx, params) => revokeInvite(ctx, idOf(params)) },
  { method: "GET", pattern: "/api/people/:id", run: showPerson },
  { method: "PATCH", pattern: "/api/people/:id", run: (ctx, params) => patchPerson(ctx, idOf(params)) },
  { method: "DELETE", pattern: "/api/people/:id", run: (ctx, params) => removePerson(ctx, idOf(params)) },
  { method: "POST", pattern: "/api/people/:id/reset-link", run: (ctx, params) => issueResetLink(ctx, idOf(params)) },
  { method: "GET", pattern: "/api/people/:id/sessions", run: forPerson((ctx, params) => json(ctx.res, { sessions: sessionViews(ctx, idOf(params)) })) },
  { method: "DELETE", pattern: "/api/people/:id/sessions", run: forPerson((ctx, params) => json(ctx.res, { status: "ok", revoked: revokeEverything(ctx, idOf(params)) })) },
  { method: "DELETE", pattern: "/api/people/:id/sessions/:sid", run: forPerson((ctx, params) => revokeOneSession(ctx, idOf(params), params.sid!)) },
];

/** `/api/people*`, operator only. True when the request was answered. */
export function handlePeopleRoute(ctx: AccountRouteContext): Promise<boolean> {
  return runOperatorRoutes(ROUTES, ctx);
}
