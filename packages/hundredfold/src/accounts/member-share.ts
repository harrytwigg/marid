import { notFound } from "../gateway/route-helpers.js";
import { accountContext, type MemberRoute, type MemberRouteContext } from "./member-context.js";
import { changeRole, inviteToBoard, membersAndInvites, removeMember, revokeBoardInvite } from "./routes-boards.js";

type OwnerRun = (ctx: MemberRouteContext, department: string) => void | Promise<void>;

/**
 * The owner board-share routes under `/api/member/boards/:department/…`: the operator's handlers, run as a board
 * owner. Every one needs the owner role on that board (an unheld board is a 404, a held one with a lower role a 403).
 */
export function shareRoutes(ownerOnBoard: (run: OwnerRun) => MemberRoute["run"]): MemberRoute[] {
  const actor = (ctx: MemberRouteContext) => ({ kind: "member", userId: ctx.principal.userId }) as const;
  return [
    { method: "GET", pattern: "/api/member/boards/:department/members", run: ownerOnBoard((ctx, department) => membersAndInvites(accountContext(ctx), department)) },
    { method: "POST", pattern: "/api/member/boards/:department/invites", run: ownerOnBoard((ctx, department) => inviteToBoard(accountContext(ctx), department, actor(ctx))) },
    { method: "DELETE", pattern: "/api/member/boards/:department/invites/:id", run: ownerOnBoard((ctx, department) => (ctx.params.id ? revokeBoardInvite(accountContext(ctx), department, ctx.params.id) : notFound(ctx.res))) },
    { method: "PATCH", pattern: "/api/member/boards/:department/members/:userId", run: ownerOnBoard((ctx, department) => changeRole(accountContext(ctx), department, ctx.params.userId!, actor(ctx))) },
    { method: "DELETE", pattern: "/api/member/boards/:department/members/:userId", run: ownerOnBoard((ctx, department) => removeMember(accountContext(ctx), department, ctx.params.userId!, actor(ctx))) },
  ];
}
