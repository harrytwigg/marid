import { badRequest, json, notFound } from "../gateway/route-helpers.js";
import { serveAttachmentBytes } from "../gateway/attachment-serve.js";
import { readWorkItemQueryParams } from "../gateway/work-item-query.js";
import { workItemTreePayload } from "../gateway/work-item-payload.js";
import { departmentRecord } from "../gateway/department-registry.js";
import { orgRegistry } from "../gateway/org-registry.js";
import { initDb } from "../shared/db.js";
import { getAttachment } from "../work-items/attachments.js";
import { COMMENT_PAGE_DEFAULT_LIMIT, COMMENT_PAGE_MAX_LIMIT, listComments } from "../work-items/comments.js";
import { memberIdentity, memberIdOf } from "../work-items/member-identity.js";
import { WORK_ITEM_STATUS_VALUES, ensureDepartmentRegistered, getWorkItem, getWorkItemTree, queryWorkItems, type WorkItem, type WorkItemPage, type WorkItemTotals } from "../work-items/store.js";
import { listGrantsForBoard, listGrantsForUser } from "./board-members.js";
import { creatorAccess, grantedBoard, grantedTodo } from "./member-access.js";
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
  const viewer = viewerOf(ctx);
  // A person filter names someone the member may read as a person: the operator, none, or a user they share a board with. Anyone
  // else is the generic `member` they read, which no Todo stores, so the filter cannot tell them who holds which Todo.
  const person = scoped.humanAssignee;
  const personId = person === undefined ? undefined : memberIdOf(person);
  if (person !== undefined && personId !== undefined && !viewer.knows(personId)) scoped.humanAssignee = "member";
  json(ctx.res, memberPagePayload(queryWorkItems({ ...scoped, rootDepartment: department, limit, offset }), viewer));
}

/**
 * The open root Todos the member filed on a board (or, with none named, on any board they hold) that are now on none of
 * their boards: another department, or the company board. Newest first, at most 200. The access rule used by reads and
 * frames is applied again to each row.
 */
function movedRootIds(ctx: MemberRouteContext, board?: string): string[] {
  const db = ctx.deps.accounts.getDb();
  const userId = ctx.principal.userId;
  const held = listGrantsForUser(db, userId).map((grant) => grant.department);
  if (held.length === 0 || (board !== undefined && !held.includes(board))) return [];
  const marks = held.map(() => "?").join(", ");
  const ids = initDb().prepare(
    `SELECT w.id FROM work_items w
     WHERE w.parent_id IS NULL AND w.created_by = ? AND w.status NOT IN ('done', 'cancelled')
       AND (w.department IS NULL OR w.department NOT IN (${marks}))
       AND (? IS NULL OR json_extract((SELECT e.detail FROM work_item_events e WHERE e.work_item_id = w.id AND e.kind = 'created' ORDER BY e.rowid LIMIT 1), '$.createdOnBoard') = ?)
     ORDER BY w.updated_at DESC, w.id ASC LIMIT 200`,
  ).pluck().all(memberIdentity(userId), ...held, board ?? null, board ?? null) as string[];
  return ids.filter((id) => {
    const access = creatorAccess(db, userId, id);
    return access !== undefined && (board === undefined || access.board === board);
  });
}

/**
 * `GET /api/member/boards/:department/moved`: the open Todos the member filed on this board that have left their boards,
 * as compact rows marked `movedToAnotherBoard`. The destination is never named.
 */
export function movedTodos(ctx: MemberRouteContext): void {
  const department = ctx.params.department;
  if (!grantedBoard(ctx, department)) return;
  const items = movedRootIds(ctx, department).map((id) => getWorkItem(id)).filter((item): item is WorkItem => item !== undefined);
  const totals = Object.fromEntries(WORK_ITEM_STATUS_VALUES.map((status) => [status, 0])) as WorkItemTotals;
  for (const item of items) totals[item.status] += 1;
  const page: WorkItemPage = { workItems: items, total: items.length, totals, limit: items.length, offset: 0, nextOffset: null };
  json(ctx.res, memberPagePayload(page, viewerOf(ctx)));
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
  // `?board=<department>` narrows the people to that one board (a person picker offers only who can be chosen there); a board the
  // member does not hold is the 404 every unheld board answers.
  const only = ctx.route.url.searchParams.get("board");
  if (only !== null && !boards.includes(only)) return notFound(ctx.res);
  const seen = new Set<string>();
  const people: Array<{ id: string; displayName: string; initials: string }> = [];
  for (const board of only !== null ? [only] : boards) {
    for (const grant of listGrantsForBoard(db, board)) {
      if (seen.has(grant.userId)) continue;
      const user = getUserById(db, grant.userId);
      if (!user || user.status !== "active") continue;
      seen.add(user.id);
      people.push({ id: user.id, displayName: user.displayName, initials: initialsOf(user.displayName) });
    }
  }
  const employees = employeesOnTrees(ctx, boards, movedRootIds(ctx));
  json(ctx.res, { people, employees });
}

/** The employees on the member's boards, and on the open trees they created that have left them. */
function employeesOnTrees(ctx: MemberRouteContext, boards: string[], movedRoots: string[]): Array<{ name: string; displayName: string; emoji?: string }> {
  if (boards.length === 0) return [];
  const marks = boards.map(() => "?").join(", ");
  const rootMarks = movedRoots.map(() => "?").join(", ");
  const names = initDb().prepare(
    `WITH tree AS (SELECT id FROM work_items WHERE root_id IN (SELECT id FROM work_items WHERE parent_id IS NULL AND (department IN (${marks})${movedRoots.length ? ` OR id IN (${rootMarks})` : ""})))
     SELECT assignee AS name FROM work_items WHERE id IN tree AND assignee IS NOT NULL
     UNION SELECT created_by FROM work_items WHERE id IN tree
     UNION SELECT author FROM work_item_comments WHERE author_kind = 'employee' AND work_item_id IN tree`,
  ).pluck().all(...boards, ...movedRoots) as string[];
  const roster = orgRegistry(ctx.deps.getConfig() as Parameters<typeof orgRegistry>[0]);
  const out: Array<{ name: string; displayName: string; emoji?: string }> = [];
  for (const name of [...new Set(names)].sort()) {
    const employee = roster.get(name);
    if (!employee) continue;
    out.push({ name: employee.name, displayName: employee.displayName ?? employee.name, ...(employee.emoji ? { emoji: employee.emoji } : {}) });
  }
  return out;
}

