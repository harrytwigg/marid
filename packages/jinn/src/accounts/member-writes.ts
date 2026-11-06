import type { Database as DatabaseType } from "better-sqlite3";
import { readTodoEditPrecondition } from "../gateway/todo-edit-precondition.js";
import { badRequest, json, notFound } from "../gateway/route-helpers.js";
import { initDb } from "../shared/db.js";
import { writeAutoStartRow } from "../work-items/auto-start.js";
import { WorkItemCreateIdempotencyConflictError, createWorkItemIdempotent } from "../work-items/create-idempotency.js";
import { DepartmentArchivedError } from "../work-items/department-archive.js";
import { setWorkItemLabels } from "../work-items/labels.js";
import { holdLiveSignalsUntilCommit } from "../work-items/live-events.js";
import { memberIdentity, memberSourceRef } from "../work-items/member-identity.js";
import { TodoDateOrderError } from "../work-items/start-date.js";
import { TodoDepartmentNotAllowedError } from "../shared/todo-departments-config.js";
import {
  WorkItemIdempotencyConflictError, WorkItemVersionConflictError, createWorkItem, getWorkItem, updateWorkItemConditional,
  type CreateWorkItemInput, type WorkItem,
} from "../work-items/store.js";
import { TransitionError, transition } from "../work-items/transitions.js";
import {
  NotMemberEditableError, NotVisibleError, RoleRefusedError, assertCollaborator, assertVisibleTodo, assertWritableTodo,
  boardOfTodo, grantedBoard, grantedTodo, requireRole, ROLE_REFUSAL, type GrantedTodo,
} from "./member-access.js";
import type { MemberRouteContext } from "./member-context.js";
import {
  keyDigest, parseCreate, parsePatch, patchKey, readObject, refuseUnsupported, scopedKey, type CreateInput, type PatchInput,
} from "./member-input.js";
import { memberWorkItem } from "./member-serialise.js";

export const actorOf = (ctx: MemberRouteContext): string => memberIdentity(ctx.principal.userId);

/** Tell the gateway's listeners (the operator's browsers, and member sockets through their filter) that a Todo changed. */
export function announce(ctx: MemberRouteContext, id: string, action: string, withValue = false): void {
  const item = getWorkItem(id);
  if (!item || !ctx.deps.emit) return;
  ctx.deps.emit("company:changed", {
    entity: "todo", action, id, version: item.version,
    ...(withValue ? { value: item as unknown as Record<string, never> } : {}),
  } as never);
}

type Answer = [new (...args: never[]) => Error, (ctx: MemberRouteContext, err: never) => void];

const WRITE_ANSWERS: readonly Answer[] = [
  [NotMemberEditableError, (ctx, err: NotMemberEditableError) => void json(ctx.res, { error: err.message, code: "todo_not_member_editable" }, 403)],
  [NotVisibleError, (ctx) => notFound(ctx.res)],
  [RoleRefusedError, (ctx) => void json(ctx.res, { error: ROLE_REFUSAL }, 403)],
  [WorkItemVersionConflictError, (ctx, err: WorkItemVersionConflictError) => void json(ctx.res, { error: "Todo changed since it was loaded.", code: "todo_version_conflict", currentVersion: err.currentVersion }, 409)],
  [WorkItemIdempotencyConflictError, (ctx, err: WorkItemIdempotencyConflictError) => void json(ctx.res, { error: "This Todo edit key was already used for a different request.", code: "todo_idempotency_conflict", currentVersion: err.currentVersion }, 409)],
  [WorkItemCreateIdempotencyConflictError, (ctx, err: WorkItemCreateIdempotencyConflictError) => void json(ctx.res, { error: err.message, code: "todo_create_idempotency_conflict" }, 409)],
  [DepartmentArchivedError, (ctx, err: DepartmentArchivedError) => void json(ctx.res, { error: err.message, code: "todo_department_archived", department: err.department }, 409)],
  [TodoDateOrderError, (ctx, err: TodoDateOrderError) => void json(ctx.res, { error: err.message, code: "todo_invalid_patch" }, 400)],
  [TransitionError, (ctx, err: TransitionError) => void answerTransition(ctx, err)],
];

function answerTransition(ctx: MemberRouteContext, err: TransitionError): void {
  if (err.code === "not-found") return notFound(ctx.res);
  json(ctx.res, { error: err.message }, err.code === "human-required" || err.code === "self-review-banned" ? 403 : 409);
}

/** Answer a failure the write paths know how to answer; false for anything else, which the caller handles. */
export function answerWriteError(ctx: MemberRouteContext, err: unknown): boolean {
  const known = WRITE_ANSWERS.find(([type]) => err instanceof type);
  if (!known) return false;
  known[1](ctx, err as never);
  return true;
}

/** What a refused write says about the one thing the store's message would over-share: which labels exist, company-wide. */
const LABEL_REFUSAL = "One or more labels do not exist on this board";

/**
 * A failure that is the caller's to fix answers 400: a label that does not exist (without the list of those that do),
 * a department that takes no new Todos, a parent that is closed or too deep. Anything else is not the member's to read:
 * it is thrown to the router, which logs it and answers a plain 500.
 */
function answerOrBadRequest(ctx: MemberRouteContext, err: unknown): void {
  if (answerWriteError(ctx, err)) return;
  if (!(err instanceof Error)) throw err;
  if (/\blabel/i.test(err.message)) return badRequest(ctx.res, LABEL_REFUSAL);
  if (err instanceof TodoDepartmentNotAllowedError) return badRequest(ctx.res, "This board does not take new Todos");
  if (/^parent Todo /.test(err.message)) return badRequest(ctx.res, err.message);
  throw err;
}

const CREATE_FIELDS = new Set(["title", "body", "parentId", "priority", "labels", "idempotencyKey"]);

/** The parent a sub-task is created under, on the board the route names; 404 (answered) for any other. `null` means no parent. */
function resolveParent(ctx: MemberRouteContext, parentId: string | null, department: string): { parent: WorkItem | null } | undefined {
  if (!parentId) return { parent: null };
  const granted = grantedTodo(ctx, parentId);
  if (!granted) return undefined;
  if (granted.board !== department) return void notFound(ctx.res);
  return { parent: granted.item };
}

function createInput(ctx: MemberRouteContext, department: string, input: CreateInput): CreateWorkItemInput {
  return {
    title: input.title,
    body: input.body,
    ...(input.parentId ? {} : { department }),
    // `connector` is a source no reader grants standing; the member is on `created_by` and the `user:` ref.
    source: "connector",
    sourceRef: memberSourceRef(ctx.principal.userId, input.key ? keyDigest(input.key) : undefined),
    parentId: input.parentId,
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    createdBy: actorOf(ctx),
  };
}

/** The create, its labels and its dispatch row, in one transaction with the tree check. */
function writeCreate(ctx: MemberRouteContext, db: DatabaseType, row: CreateWorkItemInput, input: CreateInput, parent: WorkItem | null) {
  const userId = ctx.principal.userId;
  return holdLiveSignalsUntilCommit(() => db.transaction(() => {
    // The grant, the parent and its whole tree are read again here, in the write's own transaction: the operator may
    // have moved, assigned or dispatched them since the request was routed.
    if (parent) {
      const live = assertWritableTodo(db, userId, parent.id);
      if (boardOfTodo(live) !== ctx.params.department) throw new NotVisibleError();
    } else {
      assertCollaborator(db, userId, ctx.params.department ?? null);
    }
    const result = input.key
      ? createWorkItemIdempotent(row, scopedKey(actorOf(ctx), input.key), { ...(input.labels ? { labels: input.labels } : {}), autoStart: false })
      : { item: createWorkItem(row), replayed: false };
    // A replay hands back the stored Todo, which must still be on one of the member's boards.
    if (result.replayed) assertVisibleTodo(db, userId, result.item);
    if (!result.replayed) {
      if (input.labels) setWorkItemLabels(result.item.id, input.labels, actorOf(ctx));
      // Written with the create, so the board walk can never start it, whatever happens next.
      writeAutoStartRow(db, result.item.id, false, result.item.createdAt);
    }
    return result;
  }).immediate());
}

/** `POST /api/member/boards/:department/todos`: a root Todo, or a sub-task of one in a member-only tree. Unassigned, never auto-started. */
export async function createTodo(ctx: MemberRouteContext): Promise<void> {
  const grant = grantedBoard(ctx, ctx.params.department);
  if (!grant || !requireRole(ctx, grant, "collaborator")) return;
  const body = await readObject(ctx);
  if (!body || refuseUnsupported(ctx, body, CREATE_FIELDS)) return;
  const input = parseCreate(body);
  if (!input.ok) return badRequest(ctx.res, input.error);
  const resolved = resolveParent(ctx, input.value.parentId, grant.department);
  if (!resolved) return;
  try {
    const created = writeCreate(ctx, initDb(), createInput(ctx, grant.department, input.value), input.value, resolved.parent);
    if (created.replayed) return json(ctx.res, { workItem: memberWorkItem(created.item), replayed: true });
    announce(ctx, created.item.id, "created", true);
    json(ctx.res, { workItem: memberWorkItem(getWorkItem(created.item.id)!) }, 201);
  } catch (err) {
    answerOrBadRequest(ctx, err);
  }
}

const PATCH_FIELDS = new Set(["title", "body", "priority", "labels", "expectedVersion", "idempotencyKey"]);

/** The version a patch is held to: required to change content (as on the operator's route); a labels-only call replaces a set and, like the operator's, needs none. */
function patchVersion(ctx: MemberRouteContext, body: Record<string, unknown>, input: PatchInput): { expected: number | undefined } | undefined {
  const precondition = readTodoEditPrecondition(ctx.req, body);
  if (precondition.ok) return { expected: precondition.expectedVersion };
  if (!input.editsContent && precondition.status === 428) return { expected: undefined };
  json(ctx.res, precondition.body, precondition.status);
  return undefined;
}

function writePatch(ctx: MemberRouteContext, granted: GrantedTodo, input: PatchInput, expected: number | undefined) {
  const db = initDb();
  const actor = actorOf(ctx);
  const id = granted.item.id;
  return holdLiveSignalsUntilCommit(() => db.transaction((): { item: WorkItem; replayed: boolean } => {
    assertWritableTodo(db, ctx.principal.userId, id);
    let outcome = { item: getWorkItem(id)!, replayed: false };
    if (expected !== undefined) {
      const updated = updateWorkItemConditional(id, input.fields, {
        expectedVersion: expected, ...(input.key ? { idempotencyKey: patchKey(actor, input.key, input.labels) } : {}), actor,
      });
      if (!updated) throw new NotVisibleError();
      outcome = updated;
    }
    if (input.labels && !outcome.replayed) {
      setWorkItemLabels(id, input.labels, actor);
      outcome = { item: getWorkItem(id)!, replayed: false };
    }
    return outcome;
  }).immediate());
}

/** `PATCH /api/member/todos/:id`: title, body, priority and labels, in a member-only tree. */
export async function patchTodo(ctx: MemberRouteContext): Promise<void> {
  const granted = grantedTodo(ctx, ctx.params.id);
  if (!granted || !requireRole(ctx, granted.grant, "collaborator")) return;
  const body = await readObject(ctx, { strict: true });
  if (!body || refuseUnsupported(ctx, body, PATCH_FIELDS)) return;
  const input = parsePatch(body);
  if (!input.ok) return json(ctx.res, { error: input.error, code: "todo_invalid_patch" }, 400);
  const version = patchVersion(ctx, body, input.value);
  if (!version) return;
  try {
    const result = writePatch(ctx, granted, input.value, version.expected);
    if (!result.replayed) announce(ctx, granted.item.id, "metadata-updated", true);
    json(ctx.res, { workItem: memberWorkItem(result.item), replayed: result.replayed });
  } catch (err) {
    answerOrBadRequest(ctx, err);
  }
}

/** The one move a member makes: `backlog → done`, or `done → backlog` (which carries `human: true`, never `cascade`, `manual` or `bounce`). */
function moveStatus(current: WorkItem, target: string, actor: string): WorkItem {
  if (current.status === target) return current;
  if (current.status === "backlog" && target === "done") return transition(current.id, "done", actor).item;
  if (current.status === "done" && target === "backlog") return transition(current.id, "backlog", actor, { human: true }).item;
  throw new TransitionError("illegal-edge", `Board members can only move a Todo from backlog to done, or reopen a done Todo to backlog (this one is ${current.status})`);
}

/**
 * `POST /api/member/todos/:id/status`: the two edges members get, in a member-only tree. `backlog → done` is refused
 * while the Todo has open children (members get no cascade). `transition()` writes no child-settle row for a `user:`
 * actor, so a close never queues a parent wake.
 */
export async function setStatus(ctx: MemberRouteContext): Promise<void> {
  const granted = grantedTodo(ctx, ctx.params.id);
  if (!granted || !requireRole(ctx, granted.grant, "collaborator")) return;
  const body = await readObject(ctx);
  if (!body || refuseUnsupported(ctx, body, new Set(["status"]))) return;
  if (body.status !== "done" && body.status !== "backlog") return badRequest(ctx.res, "Board members can set a Todo to done or backlog");
  const db = initDb();
  try {
    const item = holdLiveSignalsUntilCommit(() => db.transaction((): WorkItem => {
      const current = assertWritableTodo(db, ctx.principal.userId, granted.item.id);
      return moveStatus(current, body.status as string, actorOf(ctx));
    }).immediate());
    json(ctx.res, { workItem: memberWorkItem(item), escalated: false });
  } catch (err) {
    if (!answerWriteError(ctx, err)) throw err;
  }
}
