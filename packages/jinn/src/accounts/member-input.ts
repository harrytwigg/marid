import { createHash } from "node:crypto";
import { hasSupportedTodoEditContentEncoding, todoEditContentLength } from "../gateway/todo-edit-precondition.js";
import { isJsonMediaType } from "../gateway/media-type.js";
import { readJsonBody } from "../gateway/http-helpers.js";
import { badRequest, json } from "../gateway/route-helpers.js";
import { stripControlChars } from "../shared/sanitize.js";
import { TODO_LABELS_MAX } from "../work-items/labels.js";
import type { MemberRouteContext } from "./member-context.js";

/** The cap the operator's edit, comment and create requests share. */
export const BODY_MAX_BYTES = 64 * 1024;

/** Either a value or the message for the first thing wrong with it. */
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

const TOO_LARGE = { error: "Request exceeds the 64 KiB limit.", code: "request_too_large" } as const;
const INVALID_EDIT = { error: "Todo edit request must be valid JSON.", code: "todo_invalid_patch" } as const;

/** Whether the declared length is usable and within the cap; the answer is written when it is not. */
function lengthAllowed(ctx: MemberRouteContext): boolean {
  const length = todoEditContentLength(ctx.req.headers["content-length"]);
  if (length === undefined || (length !== null && length <= BODY_MAX_BYTES)) return true;
  if (length === null) badRequest(ctx.res, "request body must be valid JSON");
  else json(ctx.res, TOO_LARGE, 413);
  return false;
}

/** The framing an edit body must have (identity encoding, a JSON media type); the answer is written when it does not. */
function strictFramingAllowed(ctx: MemberRouteContext): boolean {
  const { headers } = ctx.req;
  if (hasSupportedTodoEditContentEncoding(headers["content-encoding"]) && isJsonMediaType(headers["content-type"])) return true;
  json(ctx.res, INVALID_EDIT, 400);
  return false;
}

/** A JSON object body under the size cap, or undefined once the answer is written. `strict` is the edit route's framing and duplicate-key rule. */
export async function readObject(ctx: MemberRouteContext, opts: { strict?: boolean } = {}): Promise<Record<string, unknown> | undefined> {
  if (!lengthAllowed(ctx) || (opts.strict && !strictFramingAllowed(ctx))) return undefined;
  const parsed = await readJsonBody(ctx.req, ctx.res, {
    maxBytes: BODY_MAX_BYTES, tooLargeResponse: TOO_LARGE, ...(opts.strict ? { rejectDuplicateTopLevelKeys: true } : {}),
  });
  if (!parsed.ok) return undefined;
  if (parsed.body && typeof parsed.body === "object" && !Array.isArray(parsed.body)) return parsed.body as Record<string, unknown>;
  badRequest(ctx.res, "request body must be a JSON object");
  return undefined;
}

/** Fields only the operator may set: asking for one is a refusal, not a typo. */
const OPERATOR_ONLY_FIELDS = new Set(["assignee", "department", "rank", "dueAt", "startAt", "status", "autoStart", "sprint", "provenance", "source", "sourceRef", "createdBy", "budgetUsd"]);

/** The first field the body carries that this route does not take, answered; true when one was. */
export function refuseUnsupported(ctx: MemberRouteContext, body: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  const extra = Object.keys(body).find((key) => !allowed.has(key));
  if (extra === undefined) return false;
  if (OPERATOR_ONLY_FIELDS.has(extra)) json(ctx.res, { error: `${extra} can only be set by the operator` }, 403);
  else badRequest(ctx.res, `Unsupported field: ${extra}`);
  return true;
}

export function readTitle(body: Record<string, unknown>): Parsed<string> {
  if (typeof body.title !== "string") return fail("title must be a string");
  const title = stripControlChars(body.title).trim();
  if (!title) return fail("title must not be empty");
  return title.length > 200 ? fail("title must be at most 200 characters") : ok(title);
}

export function readBodyText(body: Record<string, unknown>, nullable: boolean): Parsed<string | null | undefined> {
  const text = body.body;
  if (text === undefined || typeof text === "string") return ok(text);
  return text === null && nullable ? ok(null) : fail(nullable ? "body must be a string or null" : "body must be a string");
}

export function readLabels(body: Record<string, unknown>): Parsed<string[] | undefined> {
  const labels = body.labels;
  if (labels === undefined) return ok(undefined);
  if (!Array.isArray(labels) || labels.some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > 256)) {
    return fail("labels must be an array of label ids or names (non-empty strings)");
  }
  if (labels.length > TODO_LABELS_MAX) return fail(`labels accepts at most ${TODO_LABELS_MAX} entries per Todo (got ${labels.length})`);
  return ok((labels as string[]).map((entry) => entry.trim()));
}

export function readPriority(body: Record<string, unknown>): Parsed<number | undefined> {
  const priority = body.priority;
  if (priority === undefined) return ok(undefined);
  const valid = typeof priority === "number" && Number.isInteger(priority) && priority >= 0 && priority <= 3;
  return valid ? ok(priority) : fail("priority must be an integer from 0 through 3");
}

export function readKey(body: Record<string, unknown>): Parsed<string | undefined> {
  const key = body.idempotencyKey;
  if (key === undefined) return ok(undefined);
  if (typeof key !== "string" || !key.trim()) return fail("idempotencyKey must be a non-empty string");
  if (key.trim().length > 256) return fail("idempotencyKey is too long (max 256 characters)");
  return /[\x00-\x1f\x7f]/.test(key) ? fail("idempotencyKey contains invalid characters") : ok(key.trim());
}

export function readParentId(body: Record<string, unknown>): Parsed<string | null> {
  const parent = body.parentId;
  if (parent === undefined || parent === null) return ok(null);
  return typeof parent === "string" ? ok(parent.trim() || null) : fail("parentId must be a Todo id");
}

/** The first failure among already-parsed fields, or undefined when all are fine. */
function firstError(...fields: Array<Parsed<unknown>>): string | undefined {
  const bad = fields.find((field): field is { ok: false; error: string } => !field.ok);
  return bad?.error;
}

/** The value of a field `firstError` has already cleared. */
function val<T>(field: Parsed<T>): T {
  if (!field.ok) throw new Error("field was not checked");
  return field.value;
}

export interface CreateInput {
  title: string;
  body: string | null;
  parentId: string | null;
  priority: number | undefined;
  labels: string[] | undefined;
  key: string | undefined;
}

export function parseCreate(body: Record<string, unknown>): Parsed<CreateInput> {
  const title = readTitle(body);
  const text = readBodyText(body, true);
  const priority = readPriority(body);
  const labels = readLabels(body);
  const key = readKey(body);
  const parentId = readParentId(body);
  const error = firstError(title, text, priority, labels, key, parentId);
  if (error !== undefined) return fail(error);
  return ok({ title: val(title), body: val(text) ?? null, parentId: val(parentId), priority: val(priority), labels: val(labels), key: val(key) });
}

export interface PatchInput {
  fields: { title?: string; body?: string | null; priority?: number };
  /** Whether any of title, body or priority is being changed (a labels-only call replaces a set and needs no version). */
  editsContent: boolean;
  labels: string[] | undefined;
  key: string | undefined;
}

export function parsePatch(body: Record<string, unknown>): Parsed<PatchInput> {
  const has = (field: string) => Object.prototype.hasOwnProperty.call(body, field);
  const title = has("title") ? readTitle(body) : ok(undefined);
  const text = has("body") ? readBodyText(body, true) : ok(undefined);
  const priority = readPriority(body);
  const labels = readLabels(body);
  const key = readKey(body);
  const error = firstError(title, text, priority, labels, key);
  if (error !== undefined) return fail(error);
  const fields: PatchInput["fields"] = {
    ...(val(title) !== undefined ? { title: val(title) } : {}),
    ...(has("body") ? { body: val(text) } : {}),
    ...(val(priority) !== undefined ? { priority: val(priority) } : {}),
  };
  const editsContent = Object.keys(fields).length > 0;
  if (!editsContent && val(labels) === undefined) return fail("Todo edit request must contain at least one editable field.");
  return ok({ fields, editsContent, labels: val(labels), key: val(key) });
}

/** A key scoped to the member, so another member's (or the operator's) identical key never replays this one's write. */
export const scopedKey = (actor: string, key: string): string => `${actor}:${key}`;

/** The idempotency key a patch is replayed under: labels are not in the store's fingerprint, so they are folded into the key. */
export function patchKey(actor: string, key: string, labels: string[] | undefined): string {
  if (!labels) return scopedKey(actor, key);
  return scopedKey(actor, `${key}:labels:${createHash("sha256").update(JSON.stringify([...labels].sort())).digest("hex").slice(0, 16)}`);
}

/** A key as the sourceRef of an idempotent create: stable per (member, key), never a session. */
export const keyDigest = (key: string): string => `idempotency:${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
