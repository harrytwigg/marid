import type { Database as DatabaseType } from "better-sqlite3";
import { json, notFound } from "../gateway/route-helpers.js";
import { isTodoId } from "../work-items/id.js";
import { boardOfTodo } from "../work-items/board-of.js";
import { getWorkItem, type WorkItem } from "../work-items/store.js";
import { getGrant, type BoardGrant, type BoardRole } from "./board-members.js";
import type { MemberRouteContext } from "./member-context.js";

const RANK: Record<BoardRole, number> = { viewer: 0, collaborator: 1, owner: 2 };

export function roleAtLeast(role: BoardRole, minimum: BoardRole): boolean {
  return RANK[role] >= RANK[minimum];
}

export { boardOfTodo };

export interface GrantedTodo {
  item: WorkItem;
  board: string;
  grant: BoardGrant;
}

/**
 * The Todo a member names, if and only if it is on a board they hold. Anything else (a malformed id, an
 * unknown Todo, a Todo on a board they do not hold, the company board) answers the same 404, so a member
 * cannot probe which ids exist.
 */
export function grantedTodo(ctx: MemberRouteContext, rawId: string | undefined): GrantedTodo | undefined {
  const item = isTodoId(rawId) ? getWorkItem(rawId) : undefined;
  const board = item ? boardOfTodo(item) : null;
  const grant = board ? getGrant(ctx.deps.accounts.getDb(), ctx.principal.userId, board) : undefined;
  if (!item || !board || !grant) {
    notFound(ctx.res);
    return undefined;
  }
  return { item, board, grant };
}

/** The member's grant on a board that exists, else the 404 every unheld board answers. */
export function grantedBoard(ctx: MemberRouteContext, department: string | undefined): BoardGrant | undefined {
  const grant = department && ctx.deps.accounts.departmentExists(department)
    ? getGrant(ctx.deps.accounts.getDb(), ctx.principal.userId, department)
    : undefined;
  if (!grant) notFound(ctx.res);
  return grant;
}

export const ROLE_REFUSAL = "Your role on this board does not allow that";
export const NOT_MEMBER_EDITABLE = "Board members can only change Todos in a tree made entirely by members, with nothing assigned or started";

/** True when the grant carries the role; otherwise the 403 is written. */
export function requireRole(ctx: MemberRouteContext, grant: BoardGrant, minimum: BoardRole): boolean {
  if (roleAtLeast(grant.role, minimum)) return true;
  json(ctx.res, { error: ROLE_REFUSAL }, 403);
  return false;
}

/**
 * Whether a tree is member-only: every Todo in it (root included) was created by a member, has no
 * assignee and has no linked session. Read over the root's whole tree, so it must run inside the
 * transaction of the write it guards: the moment the operator assigns or dispatches anything, the tree
 * stops being member-only and members can only comment on it.
 */
export function isMemberOnlyTree(db: DatabaseType, rootId: string): boolean {
  const foreign = db.prepare(
    `SELECT 1 FROM work_items w
     WHERE w.root_id = ?
       AND (substr(w.created_by, 1, 5) <> 'user:'
         OR COALESCE(w.assignee, '') <> ''
         OR EXISTS (SELECT 1 FROM sessions s WHERE s.work_item_id = w.id))
     LIMIT 1`,
  ).get(rootId);
  return foreign === undefined;
}

/** Thrown inside a write transaction when the tree is not (or is no longer) member-only; rolls the write back. */
export class NotMemberEditableError extends Error {
  constructor() {
    super(NOT_MEMBER_EDITABLE);
    this.name = "NotMemberEditableError";
  }
}

export function assertMemberOnlyTree(db: DatabaseType, rootId: string): void {
  if (!isMemberOnlyTree(db, rootId)) throw new NotMemberEditableError();
}

/** Answers a refusal thrown by `assertMemberOnlyTree`; false for any other error. */
export function answerNotMemberEditable(ctx: MemberRouteContext, err: unknown): boolean {
  if (!(err instanceof NotMemberEditableError)) return false;
  json(ctx.res, { error: err.message, code: "todo_not_member_editable" }, 403);
  return true;
}

/** Thrown inside a write transaction when the Todo (or its board) is no longer one the member holds: the same 404 an unheld Todo always answers. */
export class NotVisibleError extends Error {
  constructor() {
    super("Not found");
    this.name = "NotVisibleError";
  }
}

export class RoleRefusedError extends Error {
  constructor() {
    super(ROLE_REFUSAL);
    this.name = "RoleRefusedError";
  }
}

/** The member's grant on a board, read now, at least `collaborator`; throws the 404 or 403 the routes answer. */
export function assertCollaborator(db: DatabaseType, userId: string, board: string | null): void {
  const grant = board ? getGrant(db, userId, board) : undefined;
  if (!grant) throw new NotVisibleError();
  if (!roleAtLeast(grant.role, "collaborator")) throw new RoleRefusedError();
}

/**
 * Everything a member write rests on, read again inside the write's own transaction: the Todo as it is now, the
 * grant and role on the board it is on now, and that its whole tree is member-only now. Whatever was checked before
 * the request body was read (the operator may have moved, assigned or dispatched the Todo, or removed the grant, in
 * the meantime) is not relied on.
 */
export function assertWritableTodo(db: DatabaseType, userId: string, id: string): WorkItem {
  const current = getWorkItem(id);
  if (!current) throw new NotVisibleError();
  assertCollaborator(db, userId, boardOfTodo(current));
  assertMemberOnlyTree(db, current.rootId);
  return current;
}

/** A Todo a member may still see, whatever their role: for a replayed create, which must not hand back a Todo that left their boards. */
export function assertVisibleTodo(db: DatabaseType, userId: string, item: WorkItem): void {
  const board = boardOfTodo(item);
  if (!board || !getGrant(db, userId, board)) throw new NotVisibleError();
}
