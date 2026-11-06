import { authCookieHeaders, createAuthSession, requestArrivedOverHttps, revokeAuthSessionsForUser } from "../gateway/auth.js";
import { json } from "../gateway/route-helpers.js";
import { userCookieHeader } from "./cookie.js";
import { upsertGrant } from "./board-members.js";
import { checkAttemptLimits, recordFailure } from "./login-attempts.js";
import { PASSWORD_MAX_LENGTH, passwordProblem, verifyAgainstDummy, verifyPassword } from "./passwords.js";
import {
  findToken, markTokenUsed, revokeOpenResets, tokenState, type TokenPurpose, type TokenRecord,
} from "./tokens.js";
import {
  createUserSession, pruneUserSessions, revokeUserSessionsForUser,
} from "./user-sessions.js";
import {
  createUser, getUserByEmail, getUserById, isUniqueViolation, normalizeDisplayName, normalizeEmail, publicUser,
  setUserPasswordHash, type UserRecord,
} from "./users.js";
import {
  answerHashBusy, clientIp, describeActor, hashOrBusy, readObjectBody, refuseWithoutGatewayAuth, tooManyRequests,
  type AccountRouteContext,
} from "./routes-common.js";

const LOGIN_FAILED = "Email or password is incorrect";
const LINK_DEAD = "This link is no longer valid";

/** Set the cookie a fresh session needs and answer with who is now signed in. */
function startSession(ctx: AccountRouteContext, user: UserRecord): { principal: Record<string, unknown> } {
  const { req, res, rt } = ctx;
  const secure = requestArrivedOverHttps(req);
  if (user.instanceRole === "owner") {
    // An instance owner signs in to an ordinary operator device session, so everything an operator can do works.
    const session = createAuthSession(rt.home, req, { kind: "password", userId: user.id });
    res.setHeader("Set-Cookie", authCookieHeaders(session.secret, session.device.id, rt.home, secure));
    return { principal: { kind: "operator" } };
  }
  const db = rt.getDb();
  pruneUserSessions(db, rt.now());
  const created = createUserSession(db, {
    userId: user.id, userAgent: String(req.headers["user-agent"] ?? "") || null, ip: clientIp(req) ?? null, now: rt.now(),
  });
  res.setHeader("Set-Cookie", userCookieHeader(created.token, rt.home, secure));
  const user_ = publicUser(user);
  return {
    principal: {
      kind: "member",
      user: { id: user_.id, email: user_.email, displayName: user_.displayName },
      boards: rt.boardsOf(user.id).map((grant) => ({ department: grant.department, role: grant.role })),
    },
  };
}

/** The user when the credentials are right. An unknown, disabled or password-less account still spends one hash, so timing does not say which addresses exist. */
async function checkCredentials(ctx: AccountRouteContext, rawEmail: string, password: string): Promise<UserRecord | undefined> {
  const email = normalizeEmail(rawEmail);
  const user = email ? getUserByEmail(ctx.rt.getDb(), email) : undefined;
  const usable = user !== undefined && user.status === "active" && user.passwordHash !== null && password.length <= PASSWORD_MAX_LENGTH;
  const ok = usable
    ? await verifyPassword(password, user.passwordHash!, ctx.rt.limiter)
    : await verifyAgainstDummy(password, ctx.rt.limiter);
  return ok ? user : undefined;
}

async function login(ctx: AccountRouteContext): Promise<void> {
  const { req, res, rt } = ctx;
  const body = await readObjectBody(ctx);
  if (!body) return;
  const rawEmail = typeof body.email === "string" ? body.email.trim().toLowerCase().slice(0, 254) : "";
  const password = typeof body.password === "string" ? body.password : "";
  const db = rt.getDb();
  const keys = { email: rawEmail, ip: clientIp(req) };
  // Limits come before any hashing, so a locked address or IP costs the gateway one indexed read.
  const limit = checkAttemptLimits(db, keys, rt.now());
  if (!limit.allowed) return tooManyRequests(res, limit.retryAfterSeconds);
  let user: UserRecord | undefined;
  try {
    user = await checkCredentials(ctx, rawEmail, password);
  } catch (err) {
    if (answerHashBusy(res, err)) return;
    throw err;
  }
  if (!user) {
    recordFailure(db, keys, rt.now());
    return json(res, { error: LOGIN_FAILED }, 401);
  }
  json(res, { status: "ok", ...startSession(ctx, user) });
}

/** The token if it is usable; otherwise writes the 410 (or the 429 once the IP is out of attempts) and returns undefined. */
function usableToken(ctx: AccountRouteContext, raw: unknown, purpose: TokenPurpose): TokenRecord | undefined {
  const { req, res, rt } = ctx;
  const db = rt.getDb();
  const limit = checkAttemptLimits(db, { ip: clientIp(req) }, rt.now());
  if (!limit.allowed) { tooManyRequests(res, limit.retryAfterSeconds); return undefined; }
  const token = findToken(db, raw, purpose);
  if (token && tokenState(token, rt.now()) === "valid") return token;
  recordFailure(db, { ip: clientIp(req) }, rt.now());
  json(res, { error: LINK_DEAD }, 410);
  return undefined;
}

async function inspectInvite(ctx: AccountRouteContext): Promise<void> {
  const body = await readObjectBody(ctx);
  if (!body) return;
  const token = usableToken(ctx, body.token, "invite");
  if (!token) return;
  json(ctx.res, {
    email: token.email, boardName: token.department, role: token.role, instanceRole: token.instanceRole,
    invitedBy: describeActor(ctx.rt, token.createdBy),
  });
}

/** The user, grant and session an invite creates, in one transaction with marking the token used. */
function acceptInTransaction(ctx: AccountRouteContext, token: TokenRecord, input: { displayName: string; passwordHash: string }): UserRecord | "gone" | "taken" {
  const db = ctx.rt.getDb();
  try {
    return db.transaction((): UserRecord | "gone" => {
      if (!markTokenUsed(db, token.id, ctx.rt.now())) return "gone";
      const user = createUser(db, {
        email: token.email, displayName: input.displayName, passwordHash: input.passwordHash,
        instanceRole: token.department === null ? (token.instanceRole ?? "member") : "member",
        createdBy: token.createdBy, now: ctx.rt.now(),
      });
      if (token.department !== null && token.role !== null) {
        upsertGrant(db, { userId: user.id, department: token.department, role: token.role, grantedBy: token.createdBy, now: ctx.rt.now() });
      }
      return user;
    })();
  } catch (err) {
    if (isUniqueViolation(err)) return "taken";
    throw err;
  }
}

async function acceptInvite(ctx: AccountRouteContext): Promise<void> {
  const { res } = ctx;
  if (ctx.deps.rejectIdentityGrant(ctx.req, res, "invite accept")) return;
  const body = await readObjectBody(ctx);
  if (!body) return;
  const token = usableToken(ctx, body.token, "invite"); // rejected before any password is hashed
  if (!token) return;
  const displayName = normalizeDisplayName(body.displayName);
  if (!displayName) return json(res, { error: "Display name must be 1 to 80 characters" }, 400);
  const problem = passwordProblem(body.password);
  if (problem) return json(res, { error: problem }, 400);
  const passwordHash = await hashOrBusy(ctx, body.password as string);
  if (passwordHash === undefined) return;
  const result = acceptInTransaction(ctx, token, { displayName, passwordHash });
  if (result === "gone") return json(res, { error: LINK_DEAD }, 410);
  if (result === "taken") return json(res, { error: "An account with this email already exists. Sign in instead." }, 409);
  json(res, { status: "ok", ...startSession(ctx, result) });
}

/** The reset's token and its user, when both are still good. */
function usableReset(ctx: AccountRouteContext, raw: unknown): { token: TokenRecord; user: UserRecord } | undefined {
  const token = usableToken(ctx, raw, "reset");
  if (!token) return undefined;
  const user = token.userId ? getUserById(ctx.rt.getDb(), token.userId) : undefined;
  if (user && user.status === "active") return { token, user };
  recordFailure(ctx.rt.getDb(), { ip: clientIp(ctx.req) }, ctx.rt.now());
  json(ctx.res, { error: LINK_DEAD }, 410);
  return undefined;
}

async function inspectReset(ctx: AccountRouteContext): Promise<void> {
  const body = await readObjectBody(ctx);
  if (!body) return;
  const found = usableReset(ctx, body.token);
  if (found) json(ctx.res, { email: found.user.email, displayName: found.user.displayName });
}

async function completeReset(ctx: AccountRouteContext): Promise<void> {
  const { res, rt } = ctx;
  if (ctx.deps.rejectIdentityGrant(ctx.req, res, "password reset")) return;
  const body = await readObjectBody(ctx);
  if (!body) return;
  const found = usableReset(ctx, body.token);
  if (!found) return;
  const problem = passwordProblem(body.password);
  if (problem) return json(res, { error: problem }, 400);
  const passwordHash = await hashOrBusy(ctx, body.password as string);
  if (passwordHash === undefined) return;
  const db = rt.getDb();
  const claimed = db.transaction((): boolean => {
    if (!markTokenUsed(db, found.token.id, rt.now())) return false;
    setUserPasswordHash(db, found.user.id, passwordHash, rt.now());
    revokeOpenResets(db, found.user.id, rt.now());
    return true;
  })();
  if (!claimed) return json(res, { error: LINK_DEAD }, 410);
  // A new password ends every session the old one opened: member sessions and an owner's device sessions alike.
  revokeUserSessionsForUser(db, found.user.id, { now: rt.now() });
  revokeAuthSessionsForUser(rt.home, found.user.id);
  json(res, { status: "ok" });
}

type Handler = (ctx: AccountRouteContext) => Promise<void>;

const ROUTES: Record<string, Handler> = {
  "/api/auth/login": login,
  "/api/auth/invites/inspect": inspectInvite,
  "/api/auth/invites/accept": acceptInvite,
  "/api/auth/resets/inspect": inspectReset,
  "/api/auth/resets/complete": completeReset,
};

/** The credential-free endpoints (login, invites, resets). True when one answered. */
export async function handlePublicAccountRoute(ctx: AccountRouteContext): Promise<boolean> {
  const handler = ctx.route.method === "POST" ? ROUTES[ctx.route.pathname] : undefined;
  if (!handler) return false;
  if (refuseWithoutGatewayAuth(ctx.rt, ctx.res)) return true;
  // Signing in mints an operator device for an owner: a capability-bound employee session may not do that.
  if (ctx.route.pathname === "/api/auth/login" && ctx.deps.rejectIdentityGrant(ctx.req, ctx.res, "account sign-in")) return true;
  await handler(ctx);
  return true;
}
