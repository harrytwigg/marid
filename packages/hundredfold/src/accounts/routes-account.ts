import {
  authSessionUserId, currentAuthDeviceId, linkAuthSessionToUser, revokeAuthSessionsForUser,
} from "../gateway/auth.js";
import { json } from "../gateway/route-helpers.js";
import { checkAttemptLimits, releaseAttempt, reserveAttempt } from "./login-attempts.js";
import { PASSWORD_MAX_LENGTH, passwordProblem, verifyPassword } from "./passwords.js";
import { revokeUserSessionsForUser } from "./user-sessions.js";
import {
  createUser, getUserById, isUniqueViolation, normalizeDisplayName, normalizeEmail, publicUser, setUserPasswordHash,
  type UserRecord,
} from "./users.js";
import {
  answerHashBusy, hashOrBusy, limitIp, readObjectBody, tooManyRequests, type AccountRouteContext,
} from "./routes-common.js";
import { runOperatorRoutes, type OperatorRoute } from "./routes-table.js";

/** The fields "set up my sign-in" needs, or the message for the first one that is wrong. */
function setupInput(body: Record<string, unknown>): { email: string; displayName: string; password: string } | string {
  const email = normalizeEmail(body.email);
  if (!email) return "A valid email address is required";
  const displayName = normalizeDisplayName(body.displayName);
  if (!displayName) return "Display name must be 1 to 80 characters";
  const problem = passwordProblem(body.password);
  return problem ?? { email, displayName, password: body.password as string };
}

/** "Set up my sign-in": the operator creates their own owner account, and this browser's session joins it. */
async function setupOwnerAccount(ctx: AccountRouteContext): Promise<void> {
  const { res, rt } = ctx;
  const body = await readObjectBody(ctx);
  if (!body) return;
  const deviceId = currentAuthDeviceId(ctx.req.headers, rt.home);
  if (authSessionUserId(rt.home, deviceId)) return json(res, { error: "This browser is already signed in as an account" }, 409);
  const input = setupInput(body);
  if (typeof input === "string") return json(res, { error: input }, 400);
  const passwordHash = await hashOrBusy(ctx, input.password);
  if (passwordHash === undefined) return;
  try {
    const user = createUser(rt.getDb(), { email: input.email, displayName: input.displayName, passwordHash, instanceRole: "owner", createdBy: "operator", now: rt.now() });
    // A bearer-token caller has no browser session to link; their next sign-in is by password.
    const linked = deviceId ? linkAuthSessionToUser(rt.home, deviceId, user.id) : false;
    json(res, { person: { ...publicUser(user), boards: [] }, linkedThisBrowser: linked });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    json(res, { error: "An account with this email already exists" }, 409);
  }
}

/** The account this browser is signed in as, or undefined once a 403 is written. */
function signedInOwner(ctx: AccountRouteContext, deviceId: string | undefined): UserRecord | undefined {
  const userId = authSessionUserId(ctx.rt.home, deviceId);
  const user = userId ? getUserById(ctx.rt.getDb(), userId) : undefined;
  if (user && user.status === "active" && user.passwordHash !== null) return user;
  json(ctx.res, { error: "This browser is not signed in as an account" }, 403);
  return undefined;
}

/** True when the current password is right; otherwise the attempt stays counted and the answer is written. */
export async function currentPasswordRight(ctx: AccountRouteContext, user: UserRecord, given: unknown): Promise<boolean> {
  const { res, rt } = ctx;
  const db = rt.getDb();
  const keys = { email: user.email, ip: limitIp(rt, ctx.req) };
  const limit = checkAttemptLimits(db, keys, rt.now());
  if (!limit.allowed) { tooManyRequests(res, limit.retryAfterSeconds); return false; }
  const reservation = reserveAttempt(db, keys, rt.now());
  const current = typeof given === "string" ? given : "";
  try {
    if (current.length <= PASSWORD_MAX_LENGTH && await verifyPassword(current, user.passwordHash!, rt.limiter)) {
      releaseAttempt(db, reservation);
      return true;
    }
  } catch (err) {
    releaseAttempt(db, reservation);
    if (answerHashBusy(res, err)) return false;
    throw err;
  }
  json(res, { error: "Current password is incorrect" }, 403);
  return false;
}

/** An owner changing their own password: current password required, every other session ends. */
async function changeOwnPassword(ctx: AccountRouteContext): Promise<void> {
  const { res, rt } = ctx;
  const body = await readObjectBody(ctx);
  if (!body) return;
  const deviceId = currentAuthDeviceId(ctx.req.headers, rt.home);
  const user = signedInOwner(ctx, deviceId);
  if (!user) return;
  const problem = passwordProblem(body.newPassword);
  if (problem) return json(res, { error: problem }, 400);
  if (!(await currentPasswordRight(ctx, user, body.currentPassword))) return;
  const passwordHash = await hashOrBusy(ctx, body.newPassword as string);
  if (passwordHash === undefined) return;
  setUserPasswordHash(rt.getDb(), user.id, passwordHash, rt.now());
  revokeUserSessionsForUser(rt.getDb(), user.id, { now: rt.now() });
  revokeAuthSessionsForUser(rt.home, user.id, deviceId);
  json(res, { status: "ok" });
}

const ROUTES: readonly OperatorRoute[] = [
  { method: "POST", pattern: "/api/account/setup", run: setupOwnerAccount },
  { method: "POST", pattern: "/api/account/password", run: changeOwnPassword },
];

/** `POST /api/account/setup` and `POST /api/account/password`, operator only. */
export function handleAccountRoute(ctx: AccountRouteContext): Promise<boolean> {
  return runOperatorRoutes(ROUTES, ctx);
}
