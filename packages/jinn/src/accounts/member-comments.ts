import fs from "node:fs";
import { MultipartUploadError, mimeFromFilename, readMultipartFile, sanitizeUploadFilename } from "../gateway/files.js";
import { badRequest, json, notFound } from "../gateway/route-helpers.js";
import {
  ATTACHMENT_MAX_BYTES, WorkItemAttachmentError, addAttachment, stageAttachmentBuffer,
} from "../work-items/attachments.js";
import { WorkItemCommentError, addComment, editComment, getComment, tombstoneComment, type WorkItemComment } from "../work-items/comments.js";
import { grantedTodo, requireRole, type GrantedTodo } from "./member-access.js";
import type { MemberRouteContext } from "./member-context.js";
import { readObject } from "./member-input.js";
import { memberAttachment, memberComment } from "./member-serialise.js";
import { actorOf, announce } from "./member-writes.js";

const COMMENT_ID = /^wic_[0-9a-f]{12}$/;

/** The Todo in the path when the member may write comments and files on it (a collaborator or owner of its board), else undefined once answered. */
function writableTodo(ctx: MemberRouteContext): GrantedTodo | undefined {
  const granted = grantedTodo(ctx, ctx.params.id);
  return granted && requireRole(ctx, granted.grant, "collaborator") ? granted : undefined;
}

function commentFailure(ctx: MemberRouteContext, err: unknown): void {
  if (err instanceof WorkItemCommentError) {
    if (err.code === "comment-not-found") return notFound(ctx.res);
    return json(ctx.res, { error: err.message }, err.code === "comment-forbidden" ? 403 : 409);
  }
  badRequest(ctx.res, err instanceof Error ? err.message : String(err));
}

function commentText(ctx: MemberRouteContext, body: Record<string, unknown>): string | undefined {
  const text = typeof body.body === "string" ? body.body : "";
  if (text.trim()) return text;
  badRequest(ctx.res, "body is required and must be a non-empty string");
  return undefined;
}

/** The parent a reply names, null for a top-level comment, or undefined once a 400 is written. */
function parentCommentOf(ctx: MemberRouteContext, body: Record<string, unknown>): string | null | undefined {
  const parent = body.parentCommentId;
  if (parent === undefined || parent === null) return null;
  if (typeof parent === "string" && COMMENT_ID.test(parent)) return parent;
  badRequest(ctx.res, "parentCommentId must be a comment ID such as wic_0a1b2c3d4e5f");
  return undefined;
}

/** `POST /api/member/todos/:id/comments`: stored as a `system` comment by `user:<id>`, which comment routing skips: nobody is woken. */
export async function addTodoComment(ctx: MemberRouteContext): Promise<void> {
  const granted = writableTodo(ctx);
  const body = granted && (await readObject(ctx));
  // The grant is read again once the body is in: it may have changed while the body was arriving.
  if (!granted || !body || !writableTodo(ctx)) return;
  if (body.author !== undefined || body.authorKind !== undefined) {
    return badRequest(ctx.res, "author fields cannot be supplied — comment identity is stamped from the signed-in member");
  }
  const text = commentText(ctx, body);
  const parentCommentId = parentCommentOf(ctx, body);
  if (text === undefined || parentCommentId === undefined) return;
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
  if (existing && existing.workItemId === todoId) return existing;
  notFound(ctx.res);
  return undefined;
}

/** Edit authority is the existing (author, author_kind) pair match: a member edits only their own comments. */
export async function editTodoComment(ctx: MemberRouteContext): Promise<void> {
  const granted = writableTodo(ctx);
  const body = granted && (await readObject(ctx));
  if (!granted || !body || !writableTodo(ctx)) return;
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
  const granted = writableTodo(ctx);
  if (!granted || !commentOnTodo(ctx, granted.item.id)) return;
  try {
    const comment = tombstoneComment(ctx.params.cid!, { author: actorOf(ctx), authorKind: "system", operator: false });
    announce(ctx, granted.item.id, "comment-deleted");
    json(ctx.res, { comment: memberComment(comment) });
  } catch (err) {
    commentFailure(ctx, err);
  }
}

interface Upload { filename: string; stagedPath: string; commentId: string | null }

/** The parsed multipart upload, or undefined once the answer is written. */
async function readMultipart(ctx: MemberRouteContext): Promise<Awaited<ReturnType<typeof readMultipartFile>> | undefined> {
  try {
    return await readMultipartFile(ctx.req, ATTACHMENT_MAX_BYTES);
  } catch (err) {
    if (err instanceof MultipartUploadError) {
      json(ctx.res, { error: err.message, ...(err.status === 413 ? { code: "attachment_too_large" } : {}) }, err.status);
    } else {
      badRequest(ctx.res, err instanceof Error ? err.message : String(err));
    }
    return undefined;
  }
}

/** The problem with a parsed upload, as the answer to write, or undefined when it is fine. */
function uploadProblem(upload: Awaited<ReturnType<typeof readMultipartFile>>): { status: number; body: Record<string, unknown> } | undefined {
  if (upload.truncated) return { status: 413, body: { error: "attachment exceeds the 25 MB per-file limit", code: "attachment_too_large" } };
  if (!upload.filename || upload.buffer.length === 0) return { status: 400, body: { error: "no file provided — send a multipart 'file' field with content" } };
  const commentId = upload.fields.commentId;
  if (commentId && !COMMENT_ID.test(commentId)) return { status: 400, body: { error: "commentId must be a comment ID such as wic_0a1b2c3d4e5f" } };
  return undefined;
}

/** The multipart file in the request, staged, or undefined once answered. Only the multipart form exists for members. */
async function readUpload(ctx: MemberRouteContext): Promise<Upload | undefined> {
  if (!(ctx.req.headers["content-type"] || "").toLowerCase().includes("multipart/form-data")) {
    json(ctx.res, { error: "Upload a file as multipart/form-data with a 'file' field" }, 415);
    return undefined;
  }
  const upload = await readMultipart(ctx);
  if (!upload) return undefined;
  const problem = uploadProblem(upload);
  if (problem) return void json(ctx.res, problem.body, problem.status);
  return {
    filename: sanitizeUploadFilename(upload.fields.filename?.trim() || upload.filename),
    stagedPath: stageAttachmentBuffer(upload.buffer),
    commentId: upload.fields.commentId || null,
  };
}

function attachmentFailure(ctx: MemberRouteContext, err: unknown): void {
  if (!(err instanceof WorkItemAttachmentError)) return badRequest(ctx.res, err instanceof Error ? err.message : String(err));
  if (err.code === "comment-not-found" || err.code === "attachment-not-found") return notFound(ctx.res);
  if (err.code === "attachment-forbidden") return json(ctx.res, { error: err.message }, 403);
  if (err.code === "comment-deleted") return json(ctx.res, { error: err.message }, 409);
  json(ctx.res, { error: err.message, code: "attachment_too_large" }, 413);
}

/**
 * `POST /api/member/todos/:id/attachments`: multipart upload only. The operator's JSON form names a path on the
 * gateway's own disk for the gateway to read; a member never gets that.
 */
export async function uploadAttachment(ctx: MemberRouteContext): Promise<void> {
  const granted = writableTodo(ctx);
  const upload = granted && (await readUpload(ctx));
  if (!granted || !upload) return;
  if (!writableTodo(ctx)) return fs.rmSync(upload.stagedPath, { force: true });
  try {
    const attachment = addAttachment({
      workItemId: granted.item.id, commentId: upload.commentId, filename: upload.filename, mime: mimeFromFilename(upload.filename),
      stagedPath: upload.stagedPath,
      // Attached to a comment only when it is the member's own: the same (author, kind) pair match as an edit.
      uploader: { author: actorOf(ctx), authorKind: "system", operator: false },
    });
    announce(ctx, granted.item.id, "attachment-added");
    json(ctx.res, { attachment: memberAttachment(attachment) }, 201);
  } catch (err) {
    fs.rmSync(upload.stagedPath, { force: true });
    attachmentFailure(ctx, err);
  }
}
