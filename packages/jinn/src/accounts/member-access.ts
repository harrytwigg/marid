import type { Database as DatabaseType } from "better-sqlite3";
import { json, notFound } from "../gateway/route-helpers.js";
import { isTodoId } from "../work-items/id.js";
import { boardOfTodo } from "../work-items/board-of.js";
import { getWorkItem, type WorkItem } from "../work-items/store.js";
import { memberIdentity } from "../work-items/member-identity.js";
import { getGrant, type BoardGrant, type BoardRole } from "./board-members.js";
import type { MemberRouteContext } from "./member-context.js";
import { getUserById } from "./users.js";

const RANK: Record<BoardRole, number> = { viewer: 0, collaborator: 1, owner: 2 };

export function roleAtLeast(role: BoardRole, minimum: BoardRole): boolean {
  return RANK[role] >= RANK[minimum];
}

export { boardOfTodo };

/**
 * How a member comes to read a Todo. `board`: it is on a board they hold, with their role there. `creator`: it is in an open
 * tree whose root they created and that has since left the board it was created on (to another department, or to the
 * company board); they read it, and comment when their role on that board allows comments, but never edit it.
 */
export type TodoAccess =
  | { via: "board"; board: string; grant: BoardGrant }
  | { via: "creator"; canComment: boolean };

/** Statuses that end a creator's access to a tree that left their boards. */
const CLOSED_ROOT = new Set(["done", "cancelled"]);

/** The board a member filed a root Todo on, as its `created` event recorded it; undefined for any root not filed through the member API. */
function createdOnBoard(db: DatabaseType, rootId: string): string | undefined {
  const board = db.prepare(
    "SELECT json_extract(detail, '$.createdOnBoard') FROM work_item_events WHERE work_item_id = ? AND kind = 'created' ORDER BY rowid LIMIT 1",
  ).pluck().get(rootId);
  return typeof board === "string" && board !== "" ? board : undefined;
}

/**
 * The access an open, member-created root gives its creator once it is off the board they filed it on: none unless they are
 * active, the root is theirs (`created_by = user:<id>`) and not done or cancelled, and they STILL hold the board it was
 * created on. Removing them from that board therefore ends it, and the role they keep there (collaborator or owner) is the one
 * that lets them comment: taking a board away never widens what they may do. A root with no recorded board grants nothing.
 * `asRoot` asks it of a Todo that has since been moved under another tree, as it stood when it was still a root.
 */
export function creatorAccess(db: DatabaseType, userId: string, rootId: string, opts: { asRoot?: boolean } = {}): { canComment: boolean; board: string } | undefined {
  if (!isOpenRootOf(db, userId, rootId, opts.asRoot === true)) return undefined;
  if (getUserById(db, userId)?.status !== "active") return undefined;
  const board = createdOnBoard(db, rootId);
  const grant = board ? getGrant(db, userId, board) : undefined;
  if (!board || !grant) return undefined;
  return { canComment: roleAtLeast(grant.role, "collaborator"), board };
}

/** Whether the Todo is open and was created by this user, and is a root (or, `asRoot`, was one before it was moved under another tree). */
function isOpenRootOf(db: DatabaseType, userId: string, rootId: string, asRoot: boolean): boolean {
  const root = db.prepare("SELECT parent_id, created_by, status FROM work_items WHERE id = ?").get(rootId) as
    { parent_id: string | null; created_by: string; status: string } | undefined;
  if (!root || root.created_by !== memberIdentity(userId) || CLOSED_ROOT.has(root.status)) return false;
  return root.parent_id === null || asRoot;
}

/**
 * How this member may read a Todo, read now: through a board they hold, else as the creator of its open root, else not at
 * all. The one rule behind member reads, comment writes and live frames.
 */
export function todoAccess(db: DatabaseType, userId: string, item: Pick<WorkItem, "id" | "rootId" | "department">): TodoAccess | undefined {
  const board = boardOfTodo(item);
  const grant = board ? getGrant(db, userId, board) : undefined;
  if (board && grant) return { via: "board", board, grant };
  const creator = creatorAccess(db, userId, item.rootId);
  return creator ? { via: "creator", canComment: creator.canComment } : undefined;
}

export interface GrantedTodo {
  item: WorkItem;
  /** The board the Todo is on; null on the company board. */
  board: string | null;
  access: TodoAccess;
  /** The member's grant on that board; absent when they read the Todo as its creator after it left their boards. */
  grant: BoardGrant | undefined;
}

/**
 * The Todo a member names, if and only if they may read it: it is on a board they hold, or it is in an open tree whose root
 * they created. Anything else (a malformed id, an unknown Todo, a Todo on a board they do not hold, the company board, a
 * closed tree that left their boards) answers the same 404, so a member cannot probe which ids exist.
 */
export function grantedTodo(ctx: MemberRouteContext, rawId: string | undefined): GrantedTodo | undefined {
  const item = isTodoId(rawId) ? getWorkItem(rawId) : undefined;
  const access = item ? todoAccess(ctx.deps.accounts.getDb(), ctx.principal.userId, item) : undefined;
  if (!item || !access) {
    notFound(ctx.res);
    return undefined;
  }
  return { item, board: boardOfTodo(item), access, grant: access.via === "board" ? access.grant : undefined };
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
 * True when the member may edit through their board role: they hold the Todo's board at that role. A Todo they read as its
 * creator after it left their boards is never theirs to edit, so that answers the 403 any read-only Todo answers.
 */
export function requireBoardRole(ctx: MemberRouteContext, granted: GrantedTodo, minimum: BoardRole): boolean {
  if (granted.grant) return requireRole(ctx, granted.grant, minimum);
  json(ctx.res, { error: NOT_MEMBER_EDITABLE, code: "todo_not_member_editable" }, 403);
  return false;
}

/** True when the member may comment, reply and attach on the Todo: a collaborator on its board, or the creator whose role allowed comments. */
export function requireCommenter(ctx: MemberRouteContext, granted: GrantedTodo): boolean {
  if (granted.access.via === "board") return requireRole(ctx, granted.access.grant, "collaborator");
  if (granted.access.canComment) return true;
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

/** The access the member has to this Todo now, read inside a write's transaction; throws the 404 an unreadable Todo answers. */
function currentAccess(db: DatabaseType, userId: string, item: WorkItem): TodoAccess {
  const access = todoAccess(db, userId, item);
  if (!access) throw new NotVisibleError();
  return access;
}

/**
 * Whether a comment or file write on this Todo is still allowed, read again inside its own transaction: a board role of
 * collaborator or more, or the creator's comment access. Throws the 404 or 403 the routes answer.
 */
export function assertCommenter(db: DatabaseType, userId: string, item: WorkItem): void {
  const access = currentAccess(db, userId, item);
  if (access.via === "creator") {
    if (!access.canComment) throw new RoleRefusedError();
    return;
  }
  if (!roleAtLeast(access.grant.role, "collaborator")) throw new RoleRefusedError();
}

/**
 * Everything a member write rests on, read again inside the write's own transaction: the Todo as it is now, the
 * grant and role on the board it is on now, and that its whole tree is member-only now. Whatever was checked before
 * the request body was read (the operator may have moved, assigned or dispatched the Todo, or removed the grant, in
 * the meantime) is not relied on. A Todo the member reads only as its creator, after it left their boards, is never writable.
 */
export function assertWritableTodo(db: DatabaseType, userId: string, id: string): WorkItem {
  const current = getWorkItem(id);
  if (!current) throw new NotVisibleError();
  const access = currentAccess(db, userId, current);
  if (access.via === "creator") throw new NotMemberEditableError();
  assertCollaborator(db, userId, access.board);
  assertMemberOnlyTree(db, current.rootId);
  return current;
}

/** A Todo a member may still read, whatever their role: for a replayed create, which must not hand back a Todo that left their reach. */
export function assertVisibleTodo(db: DatabaseType, userId: string, item: WorkItem): void {
  currentAccess(db, userId, item);
}
