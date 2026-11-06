import { badRequest, json, notFound } from "../gateway/route-helpers.js";
import { serveAttachmentBytes } from "../gateway/attachment-serve.js";
import { readWorkItemQueryParams } from "../gateway/work-item-query.js";
import { workItemTreePayload } from "../gateway/work-item-payload.js";
import { departmentRecord } from "../gateway/department-registry.js";
import { orgRegistry } from "../gateway/org-registry.js";
import { initDb } from "../shared/db.js";
import { getAttachment } from "../work-items/attachments.js";
import { COMMENT_PAGE_DEFAULT_LIMIT, COMMENT_PAGE_MAX_LIMIT, listComments } from "../work-items/comments.js";
import { ensureDepartmentRegistered, getWorkItemTree, queryWorkItems } from "../work-items/store.js";
import { listGrantsForBoard, listGrantsForUser } from "./board-members.js";
import { grantedBoard, grantedTodo } from "./member-access.js";
import type { MemberRouteContext } from "./member-context.js";
import {
  memberAttachments, memberCommentPage, memberDetailPayload, memberPagePayload, memberTreePayload, viewerOf,
} from "./member-serialise.js";
import { getUserById } from "./users.js";
import { initialsOf } from "./initials.js";

/** `GET /api/member/boards`: the boards the member holds, with the Todo-id prefix the web needs to name a Todo. */
export function listBoards(ctx: MemberRouteContext): void {
  const db = ctx.deps.accounts.getDb();
  const boards = listGrantsForUser(db, ctx.principal.userId).map((grant) => {
    const record = departmentRecord(grant.department);
    // A board with no Todos yet has no registry row, and the contract gives every board a prefix, so it is registered on
    // read, as the departments API registers a scoped one. Unlike that list, an open department is registered too: here it
    // is a board the operator has already shared. One whose definition file was refused is not, as there.
    if (!record.definitionError) ensureDepartmentRegistered(grant.department);
    const prefix = initDb().prepare("SELECT prefix FROM departments WHERE slug = ?").pluck().get(grant.department) as string | undefined;
    const displayName = record.definition?.displayName;
    return { department: grant.department, role: grant.role, ...(prefix ? { prefix } : {}), ...(displayName ? { displayName } : {}) };
  });
  json(ctx.res, { boards });
}

/** `GET /api/member/boards/:department/todos`: the board's list, same query shape and item serialisation as the operator's, scoped to this board. */
export function boardTodos(ctx: MemberRouteContext): void {
  const department = ctx.params.department;
  if (!grantedBoard(ctx, department)) return;
  const parsed = readWorkItemQueryParams(ctx.route.url);
  if (!parsed.ok) return badRequest(ctx.res, parsed.error);
  const { filter, limit, offset } = parsed.value;
  // The operator's desk (Home, the attention queue) is not a board: only the board's own Todos, whatever else was asked for.
  const { kept: _kept, home: _home, needsAttentionFor: _attention, needsAttentionOperator: _operator, ...scoped } = filter;
  json(ctx.res, memberPagePayload(queryWorkItems({ ...scoped, rootDepartment: department, limit, offset }), viewerOf(ctx)));
}

export function showTodo(ctx: MemberRouteContext): void {
  const granted = grantedTodo(ctx, ctx.params.id);
  if (!granted) return;
  json(ctx.res, memberDetailPayload(viewerOf(ctx), granted.item));
}

export function showTree(ctx: MemberRouteContext): void {
  const granted = grantedTodo(ctx, ctx.params.id);
  if (!granted) return;
  const tree = getWorkItemTree(granted.item.id);
  if (!tree) return notFound(ctx.res);
  json(ctx.res, { tree: memberTreePayload(workItemTreePayload(tree), viewerOf(ctx)) });
}

export function listTodoComments(ctx: MemberRouteContext): void {
  const granted = grantedTodo(ctx, ctx.params.id);
  if (!granted) return;
  let limit = COMMENT_PAGE_DEFAULT_LIMIT;
  let offset = 0;
  for (const name of ["limit", "offset"] as const) {
    const raw = ctx.route.url.searchParams.get(name);
    if (raw === null) continue;
    if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(Number(raw.trim()))) return badRequest(ctx.res, `${name} must be a non-negative integer`);
    const value = Number(raw.trim());
    if (name === "limit") limit = Math.min(Math.max(value, 1), COMMENT_PAGE_MAX_LIMIT);
    else offset = value;
  }
  json(ctx.res, { ...memberCommentPage(listComments(granted.item.id, { limit, offset }), viewerOf(ctx)), limit, offset });
}

export function listTodoAttachments(ctx: MemberRouteContext): void {
  const granted = grantedTodo(ctx, ctx.params.id);
  if (!granted) return;
  const includeSuperseded = ["1", "true"].includes(ctx.route.url.searchParams.get("includeSuperseded") ?? "");
  json(ctx.res, { attachments: memberAttachments(granted.item.id, includeSuperseded, viewerOf(ctx)) });
}

/** The bytes of one attachment, only when it belongs to the Todo named in the path and that Todo is on a held board. */
export async function readAttachment(ctx: MemberRouteContext): Promise<void> {
  const granted = grantedTodo(ctx, ctx.params.id);
  if (!granted) return;
  const attachment = getAttachment(ctx.params.aid ?? "");
  if (!attachment || attachment.workItemId !== granted.item.id) return notFound(ctx.res);
  await serveAttachmentBytes(ctx.req, ctx.res, attachment, ctx.route.pathname);
}

/**
 * `GET /api/member/people`: people on the member's boards, and the employees that hold or created Todos on
 * them (or commented on them), so an agent renders as an agent without the org route.
 */
export function listMemberPeople(ctx: MemberRouteContext): void {
  const db = ctx.deps.accounts.getDb();
  const boards = listGrantsForUser(db, ctx.principal.userId).map((grant) => grant.department);
  const seen = new Set<string>();
  const people: Array<{ id: string; displayName: string; initials: string }> = [];
  for (const board of boards) {
    for (const grant of listGrantsForBoard(db, board)) {
      if (seen.has(grant.userId)) continue;
      const user = getUserById(db, grant.userId);
      if (!user || user.status !== "active") continue;
      seen.add(user.id);
      people.push({ id: user.id, displayName: user.displayName, initials: initialsOf(user.displayName) });
    }
  }
  const employees = employeesOnBoards(ctx, boards);
  json(ctx.res, { people, employees });
}

function employeesOnBoards(ctx: MemberRouteContext, boards: string[]): Array<{ name: string; displayName: string; emoji?: string }> {
  if (boards.length === 0) return [];
  const marks = boards.map(() => "?").join(", ");
  const names = initDb().prepare(
    `WITH tree AS (SELECT id FROM work_items WHERE root_id IN (SELECT id FROM work_items WHERE parent_id IS NULL AND department IN (${marks})))
     SELECT assignee AS name FROM work_items WHERE id IN tree AND assignee IS NOT NULL
     UNION SELECT created_by FROM work_items WHERE id IN tree
     UNION SELECT author FROM work_item_comments WHERE author_kind = 'employee' AND work_item_id IN tree`,
  ).pluck().all(...boards) as string[];
  const roster = orgRegistry(ctx.deps.getConfig() as Parameters<typeof orgRegistry>[0]);
  const out: Array<{ name: string; displayName: string; emoji?: string }> = [];
  for (const name of [...new Set(names)].sort()) {
    const employee = roster.get(name);
    if (!employee) continue;
    out.push({ name: employee.name, displayName: employee.displayName ?? employee.name, ...(employee.emoji ? { emoji: employee.emoji } : {}) });
  }
  return out;
}

