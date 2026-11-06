import { revokeAuthSessionsForUser } from "../gateway/auth.js";
import { json, matchRoute, notFound, type ParsedRoute } from "../gateway/route-helpers.js";
import { requireRole, grantedBoard } from "./member-access.js";
import { accountContext, type MemberRoute, type MemberRouteContext } from "./member-context.js";
import { clearUserCookieHeader } from "./cookie.js";
import { passwordProblem } from "./passwords.js";
import {
  boardTodos, listBoards, listMemberPeople, movedTodos, listTodoAttachments, listTodoComments, readAttachment, showTodo, showTree,
} from "./member-reads.js";
import { addTodoComment, deleteTodoComment, editTodoComment, uploadAttachment } from "./member-comments.js";
import { createTodo, patchTodo, setStatus } from "./member-writes.js";
import { shareRoutes } from "./member-share.js";
import { currentPasswordRight } from "./routes-account.js";
import { hashOrBusy, readObjectBody } from "./routes-common.js";
import { getUserSession, listUserSessions, revokeUserSession, revokeUserSessionsForUser } from "./user-sessions.js";
import { publicUser, setUserPasswordHash } from "./users.js";

function me(ctx: MemberRouteContext): void {
  const { email, id, displayName } = publicUser(ctx.principal.user);
  json(ctx.res, {
    user: { id, email, displayName },
    boards: ctx.deps.accounts.boardsOf(ctx.principal.userId).map((grant) => ({ department: grant.department, role: grant.role })),
  });
}

/** Changing one's own password: the current one is required, and every other session ends. */
async function changePassword(ctx: MemberRouteContext): Promise<void> {
  const account = accountContext(ctx);
  const body = await readObjectBody(account);
  if (!body) return;
  const problem = passwordProblem(body.newPassword);
  if (problem) return json(ctx.res, { error: problem }, 400);
  const user = ctx.principal.user;
  if (!(await currentPasswordRight(account, user, body.currentPassword))) return;
  const passwordHash = await hashOrBusy(account, body.newPassword as string);
  if (passwordHash === undefined) return;
  const rt = ctx.deps.accounts;
  setUserPasswordHash(rt.getDb(), user.id, passwordHash, rt.now());
  revokeUserSessionsForUser(rt.getDb(), user.id, { exceptSessionId: ctx.principal.sessionId, now: rt.now() });
  revokeAuthSessionsForUser(rt.home, user.id);
  json(ctx.res, { status: "ok" });
}

function listSessions(ctx: MemberRouteContext): void {
  const rt = ctx.deps.accounts;
  json(ctx.res, {
    sessions: listUserSessions(rt.getDb(), ctx.principal.userId, rt.now()).map((session) => ({
      id: session.id, kind: "member", createdAt: session.createdAt, lastSeenAt: session.lastSeenAt, expiresAt: session.expiresAt,
      userAgent: session.userAgent, ip: session.ip, current: session.id === ctx.principal.sessionId,
    })),
  });
}

/** Revoking one of one's own sessions; another person's session id is as unknown as any other. */
function revokeSession(ctx: MemberRouteContext): void {
  const rt = ctx.deps.accounts;
  const session = getUserSession(rt.getDb(), ctx.params.id ?? "");
  if (!session || session.userId !== ctx.principal.userId || !revokeUserSession(rt.getDb(), session.id, rt.now())) return notFound(ctx.res);
  const current = session.id === ctx.principal.sessionId;
  if (current) ctx.res.setHeader("Set-Cookie", clearUserCookieHeader(rt.home));
  json(ctx.res, { status: "ok", current });
}

/** A route that needs the owner role on the board it names. */
const ownerOnBoard = (run: (ctx: MemberRouteContext, department: string) => void | Promise<void>): MemberRoute["run"] => (ctx) => {
  const grant = grantedBoard(ctx, ctx.params.department);
  if (!grant || !requireRole(ctx, grant, "owner")) return;
  return run(ctx, grant.department);
};

export const MEMBER_ROUTES: readonly MemberRoute[] = [
  { method: "GET", pattern: "/api/member/me", run: me },
  { method: "POST", pattern: "/api/member/password", run: changePassword },
  { method: "GET", pattern: "/api/member/sessions", run: listSessions },
  { method: "DELETE", pattern: "/api/member/sessions/:id", run: revokeSession },
  { method: "GET", pattern: "/api/member/boards", run: listBoards },
  { method: "GET", pattern: "/api/member/people", run: listMemberPeople },
  { method: "GET", pattern: "/api/member/moved", run: movedTodos },
  { method: "GET", pattern: "/api/member/boards/:department/todos", run: boardTodos },
  { method: "POST", pattern: "/api/member/boards/:department/todos", run: createTodo },
  ...shareRoutes(ownerOnBoard),
  { method: "GET", pattern: "/api/member/todos/:id", run: showTodo },
  { method: "PATCH", pattern: "/api/member/todos/:id", run: patchTodo },
  { method: "GET", pattern: "/api/member/todos/:id/tree", run: showTree },
  { method: "POST", pattern: "/api/member/todos/:id/status", run: setStatus },
  { method: "GET", pattern: "/api/member/todos/:id/comments", run: listTodoComments },
  { method: "POST", pattern: "/api/member/todos/:id/comments", run: addTodoComment },
  { method: "PATCH", pattern: "/api/member/todos/:id/comments/:cid", run: editTodoComment },
  { method: "DELETE", pattern: "/api/member/todos/:id/comments/:cid", run: deleteTodoComment },
  { method: "GET", pattern: "/api/member/todos/:id/attachments", run: listTodoAttachments },
  { method: "POST", pattern: "/api/member/todos/:id/attachments", run: uploadAttachment },
  { method: "GET", pattern: "/api/member/todos/:id/attachments/:aid", run: readAttachment },
];

/** Run the first member route that matches; false when none does (the caller answers 404). */
export async function runMemberRoutes(base: Omit<MemberRouteContext, "params" | "route">, route: ParsedRoute): Promise<boolean> {
  for (const candidate of MEMBER_ROUTES) {
    if (candidate.method !== route.method) continue;
    const params = matchRoute(candidate.pattern, route.pathname);
    if (!params) continue;
    await candidate.run({ ...base, route, params });
    return true;
  }
  return false;
}

