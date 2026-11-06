import { createHash } from "node:crypto";
import fs from "node:fs";
import { MultipartUploadError, mimeFromFilename, readMultipartFile, sanitizeUploadFilename } from "../gateway/files.js";
import { hasSupportedTodoEditContentEncoding, readTodoEditPrecondition, todoEditContentLength } from "../gateway/todo-edit-precondition.js";
import { isJsonMediaType } from "../gateway/media-type.js";
import { readJsonBody } from "../gateway/http-helpers.js";
import { badRequest, json, notFound } from "../gateway/route-helpers.js";
import { stripControlChars } from "../shared/sanitize.js";
import {
  ATTACHMENT_MAX_BYTES, WorkItemAttachmentError, addAttachment, stageAttachmentBuffer,
} from "../work-items/attachments.js";
import { writeAutoStartRow } from "../work-items/auto-start.js";
import {
  WorkItemCommentError, addComment, editComment, getComment, tombstoneComment, type WorkItemComment,
} from "../work-items/comments.js";
import { WorkItemCreateIdempotencyConflictError, createWorkItemIdempotent } from "../work-items/create-idempotency.js";
import { DepartmentArchivedError } from "../work-items/department-archive.js";
import { TODO_LABELS_MAX, setWorkItemLabels } from "../work-items/labels.js";
import { holdLiveSignalsUntilCommit } from "../work-items/live-events.js";
import { memberIdentity, memberSourceRef } from "../work-items/member-identity.js";
import {
  WorkItemIdempotencyConflictError, WorkItemVersionConflictError, createWorkItem, getWorkItem, updateWorkItemConditional,
  type CreateWorkItemInput, type UpdateWorkItemInput, type WorkItem,
} from "../work-items/store.js";
import { TransitionError, transition } from "../work-items/transitions.js";
import { initDb } from "../shared/db.js";
import { TodoDateOrderError } from "../work-items/start-date.js";
import {
  answerNotMemberEditable, assertMemberOnlyTree, grantedBoard, grantedTodo, requireRole,
} from "./member-access.js";
import type { MemberRouteContext } from "./member-context.js";
import { memberAttachment, memberComment, memberWorkItem } from "./member-serialise.js";

/** The cap the operator's edit, comment and create requests share. */
const BODY_MAX_BYTES = 64 * 1024;

const actorOf = (ctx: MemberRouteContext): string => memberIdentity(ctx.principal.userId);

/** A member-scoped idempotency key: another member's (or the operator's) identical key never replays this one's write. */
const scopedKey = (ctx: MemberRouteContext, key: string): string => `${actorOf(ctx)}:${key}`;

/** Tell the gateway's listeners (the operator's browsers, and member sockets through their filter) that a Todo changed. */
function announce(ctx: MemberRouteContext, id: string, action: string, withValue = false): void {
  const item = getWorkItem(id);
  if (!item || !ctx.deps.emit) return;
  ctx.deps.emit("company:changed", {
    entity: "todo", action, id, version: item.version,
    ...(withValue ? { value: item as unknown as Record<string, never> } : {}),
  } as never);
}

/** A JSON object body under the size cap, or undefined once the answer is written. */
async function readObject(ctx: MemberRouteContext, opts: { strict?: boolean } = {}): Promise<Record<string, unknown> | undefined> {
  const { req, res } = ctx;
  const tooLarge = { error: "Request exceeds the 64 KiB limit.", code: "request_too_large" } as const;
  const length = todoEditContentLength(req.headers["content-length"]);
  if (length === null) return void badRequest(res, "request body must be valid JSON");
  if (length !== undefined && length > BODY_MAX_BYTES) return void json(res, tooLarge, 413);
  if (opts.strict) {
    if (!hasSupportedTodoEditContentEncoding(req.headers["content-encoding"]) || !isJsonMediaType(req.headers["content-type"])) {
      return void json(res, { error: "Todo edit request must be valid JSON.", code: "todo_invalid_patch" }, 400);
    }
  }
  const parsed = await readJsonBody(req, res, {
    maxBytes: BODY_MAX_BYTES, tooLargeResponse: tooLarge, ...(opts.strict ? { rejectDuplicateTopLevelKeys: true } : {}),
  });
  if (!parsed.ok) return undefined;
  if (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body)) {
    return void badRequest(res, "request body must be a JSON object");
  }
  return parsed.body as Record<string, unknown>;
}

/** Fields only the operator may set: asking for one is a refusal, not a typo. */
const OPERATOR_ONLY_FIELDS = new Set(["assignee", "department", "rank", "dueAt", "startAt", "status", "autoStart", "sprint", "provenance", "source", "sourceRef", "createdBy", "budgetUsd"]);

/** The first field the body carries that this route does not take, answered; true when one was. */
function refuseUnsupported(ctx: MemberRouteContext, body: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  const extra = Object.keys(body).find((key) => !allowed.has(key));
  if (extra === undefined) return false;
  if (OPERATOR_ONLY_FIELDS.has(extra)) json(ctx.res, { error: `${extra} can only be set by the operator` }, 403);
  else badRequest(ctx.res, `Unsupported field: ${extra}`);
  return true;
}

function readTitle(body: Record<string, unknown>): string | { error: string } {
  if (typeof body.title !== "string") return { error: "title must be a string" };
  const title = stripControlChars(body.title).trim();
  if (!title) return { error: "title must not be empty" };
  if (title.length > 200) return { error: "title must be at most 200 characters" };
  return title;
}

function readLabels(body: Record<string, unknown>): string[] | { error: string } {
  const labels = body.labels;
  if (!Array.isArray(labels) || labels.some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > 256)) {
    return { error: "labels must be an array of label ids or names (non-empty strings)" };
  }
  if (labels.length > TODO_LABELS_MAX) return { error: `labels accepts at most ${TODO_LABELS_MAX} entries per Todo (got ${labels.length})` };
  return (labels as string[]).map((entry) => entry.trim());
}

function readPriority(body: Record<string, unknown>): number | { error: string } {
  const priority = body.priority;
  if (typeof priority !== "number" || !Number.isInteger(priority) || priority < 0 || priority > 3) return { error: "priority must be an integer from 0 through 3" };
  return priority;
}

function readKey(body: Record<string, unknown>): string | undefined | { error: string } {
  if (body.idempotencyKey === undefined) return undefined;
  const key = body.idempotencyKey;
  if (typeof key !== "string" || !key.trim()) return { error: "idempotencyKey must be a non-empty string" };
  if (key.trim().length > 256) return { error: "idempotencyKey is too long (max 256 characters)" };
  if (/[\x00-\x1f\x7f]/.test(key)) return { error: "idempotencyKey contains invalid characters" };
  return key.trim();
}

const failed = (value: unknown): value is { error: string } => typeof value === "object" && value !== null && "error" in value;

function archivedRefusal(ctx: MemberRouteContext, err: DepartmentArchivedError): void {
  json(ctx.res, { error: err.message, code: "todo_department_archived", department: err.department }, 409);
}

const CREATE_FIELDS = new Set(["title", "body", "parentId", "priority", "labels", "idempotencyKey"]);

/** `POST /api/member/boards/:department/todos`: a root Todo, or a sub-task of one in a member-only tree. Unassigned, never auto-started. */
export async function createTodo(ctx: MemberRouteContext): Promise<void> {
  const department = ctx.params.department;
  const grant = grantedBoard(ctx, department);
  if (!grant || !requireRole(ctx, grant, "collaborator")) return;
  const body = await readObject(ctx);
  if (!body || refuseUnsupported(ctx, body, CREATE_FIELDS)) return;
  const title = readTitle(body);
  if (failed(title)) return badRequest(ctx.res, title.error);
  if (body.body !== undefined && body.body !== null && typeof body.body !== "string") return badRequest(ctx.res, "body must be a string");
  const priority = body.priority === undefined ? undefined : readPriority(body);
  if (failed(priority)) return badRequest(ctx.res, priority.error);
  const labels = body.labels === undefined ? undefined : readLabels(body);
  if (failed(labels)) return badRequest(ctx.res, labels.error);
  const key = readKey(body);
  if (failed(key)) return badRequest(ctx.res, key.error);
  const parentId = typeof body.parentId === "string" && body.parentId.trim() ? body.parentId.trim() : null;
  if (body.parentId !== undefined && body.parentId !== null && typeof body.parentId !== "string") return badRequest(ctx.res, "parentId must be a Todo id");
  let parent: WorkItem | undefined;
  if (parentId) {
    const granted = grantedTodo(ctx, parentId);
    if (!granted) return;
    // A sub-task is created on the board its parent is on, which must be the one the route names.
    if (granted.board !== department) return notFound(ctx.res);
    parent = granted.item;
  }
  const userId = ctx.principal.userId;
  const actor = actorOf(ctx);
  const input: CreateWorkItemInput = {
    title: title as string,
    body: typeof body.body === "string" ? body.body : null,
    ...(parent ? {} : { department }),
    // `connector` is a source no reader grants standing; the member is on `created_by` and the `user:` ref.
    source: "connector",
    sourceRef: memberSourceRef(userId, key ? `idempotency:${createHash("sha256").update(key).digest("hex").slice(0, 24)}` : undefined),
    parentId,
    ...(priority !== undefined ? { priority: priority as number } : {}),
    createdBy: actor,
  };
  const db = initDb();
  try {
    const created = holdLiveSignalsUntilCommit(() => db.transaction(() => {
      // The whole tree is checked in the same transaction as the write: it may not stop being member-only in between.
      if (parent) assertMemberOnlyTree(db, parent.rootId);
      const result = key
        ? createWorkItemIdempotent(input, scopedKey(ctx, key), { ...(labels ? { labels: labels as string[] } : {}), autoStart: false })
        : { item: createWorkItem(input), replayed: false };
      if (!result.replayed) {
        if (labels) setWorkItemLabels(result.item.id, labels as string[], actor);
        // Written with the create, so the board walk can never start it, whatever happens next.
        writeAutoStartRow(db, result.item.id, false, result.item.createdAt);
      }
      return result;
    }).immediate());
    if (created.replayed) return json(ctx.res, { workItem: memberWorkItem(created.item), replayed: true });
    announce(ctx, created.item.id, "created", true);
    json(ctx.res, { workItem: memberWorkItem(getWorkItem(created.item.id)!) }, 201);
  } catch (err) {
    if (answerNotMemberEditable(ctx, err)) return;
    if (err instanceof WorkItemCreateIdempotencyConflictError) {
      return json(ctx.res, { error: err.message, code: "todo_create_idempotency_conflict" }, 409);
    }
    if (err instanceof DepartmentArchivedError) return archivedRefusal(ctx, err);
    badRequest(ctx.res, err instanceof Error ? err.message : String(err));
  }
}

const PATCH_FIELDS = new Set(["title", "body", "priority", "labels", "expectedVersion", "idempotencyKey"]);
const EDIT_FIELDS = ["title", "body", "priority"] as const;

/** The idempotency key a patch is replayed under: labels are not in the store's fingerprint, so they are folded into the key. */
function patchKey(ctx: MemberRouteContext, key: string, labels: string[] | undefined): string {
  return scopedKey(ctx, labels ? `${key}:labels:${createHash("sha256").update(JSON.stringify([...labels].sort())).digest("hex").slice(0, 16)}` : key);
}

/** `PATCH /api/member/todos/:id`: title, body, priority and labels, in a member-only tree. */
export async function patchTodo(ctx: MemberRouteContext): Promise<void> {
  const granted = grantedTodo(ctx, ctx.params.id);
  if (!granted || !requireRole(ctx, granted.grant, "collaborator")) return;
  const body = await readObject(ctx, { strict: true });
  if (!body || refuseUnsupported(ctx, body, PATCH_FIELDS)) return;
  const edits = EDIT_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(body, field));
  if (edits.length === 0 && body.labels === undefined) {
    return json(ctx.res, { error: "Todo edit request must contain at least one editable field.", code: "todo_invalid_patch" }, 400);
  }
  const patch: UpdateWorkItemInput = {};
  if (Object.prototype.hasOwnProperty.call(body, "title")) {
    const title = readTitle(body);
    if (failed(title)) return json(ctx.res, { error: title.error, code: "todo_invalid_patch" }, 400);
    patch.title = title;
  }
  if (Object.prototype.hasOwnProperty.call(body, "body")) {
    if (body.body !== null && typeof body.body !== "string") return json(ctx.res, { error: "body must be a string or null", code: "todo_invalid_patch" }, 400);
    patch.body = body.body as string | null;
  }
  if (Object.prototype.hasOwnProperty.call(body, "priority")) {
    const priority = readPriority(body);
    if (failed(priority)) return json(ctx.res, { error: priority.error, code: "todo_invalid_patch" }, 400);
    patch.priority = priority;
  }
  const labels = body.labels === undefined ? undefined : readLabels(body);
  if (failed(labels)) return json(ctx.res, { error: labels.error, code: "todo_invalid_patch" }, 400);
  const key = readKey(body);
  if (failed(key)) return json(ctx.res, { error: key.error, code: "todo_invalid_patch" }, 400);
  // A version is required to change content (as on the operator's route); a labels-only call replaces a set and, like the operator's, needs none.
  const labelsOnly = edits.length === 0;
  const precondition = readTodoEditPrecondition(ctx.req, body);
  if (!precondition.ok && !(labelsOnly && precondition.status === 428)) return json(ctx.res, precondition.body, precondition.status);
  const db = initDb();
  const actor = actorOf(ctx);
  const id = granted.item.id;
  try {
    const result = holdLiveSignalsUntilCommit(() => db.transaction((): { item: WorkItem; replayed: boolean } => {
      assertMemberOnlyTree(db, granted.item.rootId);
      let outcome: { item: WorkItem; replayed: boolean };
      if (labelsOnly && !precondition.ok) {
        outcome = { item: getWorkItem(id)!, replayed: false };
      } else {
        const updated = updateWorkItemConditional(id, patch, {
          expectedVersion: (precondition as { expectedVersion: number }).expectedVersion,
          ...(key ? { idempotencyKey: patchKey(ctx, key, labels as string[] | undefined) } : {}),
          actor,
        });
        if (!updated) throw new TodoGone();
        outcome = updated;
      }
      if (labels && !outcome.replayed) {
        setWorkItemLabels(id, labels as string[], actor);
        outcome = { item: getWorkItem(id)!, replayed: false };
      }
      return outcome;
    }).immediate());
    if (!result.replayed) announce(ctx, id, "metadata-updated", true);
    json(ctx.res, { workItem: memberWorkItem(result.item), replayed: result.replayed });
  } catch (err) {
    if (answerNotMemberEditable(ctx, err)) return;
    if (err instanceof TodoGone) return notFound(ctx.res);
    if (err instanceof WorkItemVersionConflictError) {
      return json(ctx.res, { error: "Todo changed since it was loaded.", code: "todo_version_conflict", currentVersion: err.currentVersion }, 409);
    }
    if (err instanceof WorkItemIdempotencyConflictError) {
      return json(ctx.res, { error: "This Todo edit key was already used for a different request.", code: "todo_idempotency_conflict", currentVersion: err.currentVersion }, 409);
    }
    if (err instanceof DepartmentArchivedError) return archivedRefusal(ctx, err);
    if (err instanceof TodoDateOrderError) return json(ctx.res, { error: err.message, code: "todo_invalid_patch" }, 400);
    if (err instanceof Error && !(err instanceof TransitionError)) return badRequest(ctx.res, err.message);
    throw err;
  }
}

class TodoGone extends Error {}

const MEMBER_STATUSES = new Set(["done", "backlog"]);

/**
 * `POST /api/member/todos/:id/status`: the two edges members get, in a member-only tree. `backlog → done`,
 * refused while the Todo has open children (no cascade); and `done → backlog`, which carries `human: true`
 * (the reopen edge requires it) and never `cascade`, `manual` or `bounce`. `transition()` writes no child-settle
 * row for a `user:` actor, so a close never queues a parent wake.
 */
export async function setStatus(ctx: MemberRouteContext): Promise<void> {
  const granted = grantedTodo(ctx, ctx.params.id);
  if (!granted || !requireRole(ctx, granted.grant, "collaborator")) return;
  const body = await readObject(ctx);
  if (!body || refuseUnsupported(ctx, body, new Set(["status"]))) return;
  const target = typeof body.status === "string" ? body.status : "";
  if (!MEMBER_STATUSES.has(target)) return badRequest(ctx.res, "Board members can set a Todo to done or backlog");
  const db = initDb();
  const actor = actorOf(ctx);
  try {
    const item = holdLiveSignalsUntilCommit(() => db.transaction((): WorkItem => {
      assertMemberOnlyTree(db, granted.item.rootId);
      const current = getWorkItem(granted.item.id);
      if (!current) throw new TodoGone();
      if (current.status === target) return current;
      if (current.status === "backlog" && target === "done") return transition(current.id, "done", actor).item;
      if (current.status === "done" && target === "backlog") return transition(current.id, "backlog", actor, { human: true }).item;
      throw new TransitionError("illegal-edge", `Board members can only move a Todo from backlog to done, or reopen a done Todo to backlog (this one is ${current.status})`);
    }).immediate());
    json(ctx.res, { workItem: memberWorkItem(item), escalated: false });
  } catch (err) {
    if (answerNotMemberEditable(ctx, err)) return;
    if (err instanceof TodoGone) return notFound(ctx.res);
    if (err instanceof TransitionError) {
      if (err.code === "not-found") return notFound(ctx.res);
      return json(ctx.res, { error: err.message }, err.code === "illegal-edge" || err.code === "children-open" ? 409 : 403);
    }
    throw err;
  }
}

function commentFailure(ctx: MemberRouteContext, err: unknown): void {
  if (err instanceof WorkItemCommentError) {
    if (err.code === "comment-not-found") return notFound(ctx.res);
    return json(ctx.res, { error: err.message }, err.code === "comment-forbidden" ? 403 : 409);
  }
  if (err instanceof Error) return badRequest(ctx.res, err.message);
  badRequest(ctx.res, String(err));
}

function commentText(ctx: MemberRouteContext, body: Record<string, unknown>): string | undefined {
  const text = typeof body.body === "string" ? body.body : "";
  if (!text.trim()) return void badRequest(ctx.res, "body is required and must be a non-empty string");
  return text;
}

/** `POST /api/member/todos/:id/comments`: stored as a `system` comment by `user:<id>`, which comment routing skips: nobody is woken. */
export async function addTodoComment(ctx: MemberRouteContext): Promise<void> {
  const granted = grantedTodo(ctx, ctx.params.id);
  if (!granted || !requireRole(ctx, granted.grant, "collaborator")) return;
  const body = await readObject(ctx);
  if (!body) return;
  if (body.author !== undefined || body.authorKind !== undefined) {
    return badRequest(ctx.res, "author fields cannot be supplied — comment identity is stamped from the signed-in member");
  }
  const text = commentText(ctx, body);
  if (text === undefined) return;
  let parentCommentId: string | null = null;
  if (body.parentCommentId !== undefined && body.parentCommentId !== null) {
    if (typeof body.parentCommentId !== "string" || !/^wic_[0-9a-f]{12}$/.test(body.parentCommentId)) {
      return badRequest(ctx.res, "parentCommentId must be a comment ID such as wic_0a1b2c3d4e5f");
    }
    parentCommentId = body.parentCommentId;
  }
  try {
    const comment = addComment({ workItemId: granted.item.id, body: text, author: actorOf(ctx), authorKind: "system", parentCommentId });
    announce(ctx, granted.item.id, "commented");
    json(ctx.res, { comment: memberComment(comment) }, 201);
  } catch (err) {
    commentFailure(ctx, err);
  }
}

/** The comment in the path, on the Todo in the path; else the 404 an unknown comment answers. */
function commentOnTodo(ctx: MemberRouteContext, todoId: string): WorkItemComment | undefined {
  const existing = getComment(ctx.params.cid ?? "");
  if (!existing || existing.workItemId !== todoId) return void notFound(ctx.res);
  return existing;
}

/** Edit authority is the existing (author, author_kind) pair match: a member edits only their own comments. */
export async function editTodoComment(ctx: MemberRouteContext): Promise<void> {
  const granted = grantedTodo(ctx, ctx.params.id);
  if (!granted || !requireRole(ctx, granted.grant, "collaborator")) return;
  const body = await readObject(ctx);
  if (!body) return;
  const text = commentText(ctx, body);
  if (text === undefined || !commentOnTodo(ctx, granted.item.id)) return;
  try {
    const comment = editComment(ctx.params.cid!, text, { author: actorOf(ctx), authorKind: "system", operator: false });
    announce(ctx, granted.item.id, "comment-edited");
    json(ctx.res, { comment: memberComment(comment) });
  } catch (err) {
    commentFailure(ctx, err);
  }
}

export function deleteTodoComment(ctx: MemberRouteContext): void {
  const granted = grantedTodo(ctx, ctx.params.id);
  if (!granted || !requireRole(ctx, granted.grant, "collaborator") || !commentOnTodo(ctx, granted.item.id)) return;
  try {
    const comment = tombstoneComment(ctx.params.cid!, { author: actorOf(ctx), authorKind: "system", operator: false });
    announce(ctx, granted.item.id, "comment-deleted");
    json(ctx.res, { comment: memberComment(comment) });
  } catch (err) {
    commentFailure(ctx, err);
  }
}

/**
 * `POST /api/member/todos/:id/attachments`: multipart upload only. The operator's JSON form names a path on the
 * gateway's own disk for the gateway to read; a member never gets that.
 */
export async function uploadAttachment(ctx: MemberRouteContext): Promise<void> {
  const granted = grantedTodo(ctx, ctx.params.id);
  if (!granted || !requireRole(ctx, granted.grant, "collaborator")) return;
  const contentType = (ctx.req.headers["content-type"] || "").toLowerCase();
  if (!contentType.includes("multipart/form-data")) {
    return json(ctx.res, { error: "Upload a file as multipart/form-data with a 'file' field" }, 415);
  }
  let upload: Awaited<ReturnType<typeof readMultipartFile>>;
  try {
    upload = await readMultipartFile(ctx.req, ATTACHMENT_MAX_BYTES);
  } catch (err) {
    if (err instanceof MultipartUploadError) return json(ctx.res, { error: err.message, ...(err.status === 413 ? { code: "attachment_too_large" } : {}) }, err.status);
    return badRequest(ctx.res, err instanceof Error ? err.message : String(err));
  }
  if (upload.truncated) return json(ctx.res, { error: "attachment exceeds the 25 MB per-file limit", code: "attachment_too_large" }, 413);
  if (!upload.filename || upload.buffer.length === 0) return badRequest(ctx.res, "no file provided — send a multipart 'file' field with content");
  const filename = sanitizeUploadFilename(upload.fields.filename?.trim() || upload.filename);
  const commentIdRaw = upload.fields.commentId || undefined;
  if (commentIdRaw !== undefined && !/^wic_[0-9a-f]{12}$/.test(commentIdRaw)) {
    return badRequest(ctx.res, "commentId must be a comment ID such as wic_0a1b2c3d4e5f");
  }
  const stagedPath = stageAttachmentBuffer(upload.buffer);
  try {
    const attachment = addAttachment({
      workItemId: granted.item.id,
      commentId: commentIdRaw ?? null,
      filename,
      mime: mimeFromFilename(filename),
      stagedPath,
      // Attached to a comment only when it is the member's own: the same (author, kind) pair match as an edit.
      uploader: { author: actorOf(ctx), authorKind: "system", operator: false },
    });
    announce(ctx, granted.item.id, "attachment-added");
    json(ctx.res, { attachment: memberAttachment(attachment) }, 201);
  } catch (err) {
    fs.rmSync(stagedPath, { force: true });
    if (err instanceof WorkItemAttachmentError) {
      if (err.code === "comment-not-found" || err.code === "attachment-not-found") return notFound(ctx.res);
      if (err.code === "attachment-forbidden") return json(ctx.res, { error: err.message }, 403);
      if (err.code === "comment-deleted") return json(ctx.res, { error: err.message }, 409);
      return json(ctx.res, { error: err.message, code: "attachment_too_large" }, 413);
    }
    badRequest(ctx.res, err instanceof Error ? err.message : String(err));
  }
}

