import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { json } from "./route-helpers.js";

/**
 * The concurrency precondition every Todo edit carries: the version the caller
 * believes it is editing, supplied either as `expectedVersion` in the body or
 * as an `If-Match` ETag. An edit with neither is refused before it is read —
 * blind writes are how two agents overwrite each other silently.
 *
 * Also the two request-framing checks the edit route makes before parsing:
 * a well-formed `Content-Length` and an uncompressed body.
 */

export type TodoEditPrecondition =
  | { ok: true; expectedVersion: number }
  | { ok: false; status: 400 | 428; body: { error: string; code: 'todo_precondition_required' | 'todo_invalid_version' } };

function positiveTodoVersion(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function ifMatchTodoVersion(value: string | string[] | undefined): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(?:"([1-9]\d*)"|([1-9]\d*))$/.exec(value.trim());
  if (!match) return undefined;
  const parsed = Number(match[1] ?? match[2]);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/** One of the two places a version can arrive from: `undefined` when the caller
 *  did not supply it at all, `null` when they did and it is unusable. The
 *  difference is the whole point — absent means "no precondition", unusable
 *  means "a precondition the server must not guess at". */
function suppliedVersion(supplied: boolean, parse: () => number | undefined): number | undefined | null {
  if (!supplied) return undefined;
  return parse() ?? null;
}

export function readTodoEditPrecondition(req: HttpRequest, body: Record<string, unknown>): TodoEditPrecondition {
  const bodyVersion = suppliedVersion(
    Object.prototype.hasOwnProperty.call(body, 'expectedVersion'),
    () => positiveTodoVersion(body.expectedVersion),
  );
  const headerVersion = suppliedVersion(
    req.headers['if-match'] !== undefined,
    () => ifMatchTodoVersion(req.headers['if-match']),
  );
  if (bodyVersion === undefined && headerVersion === undefined) {
    return { ok: false, status: 428, body: { error: 'A current Todo version is required.', code: 'todo_precondition_required' } };
  }
  if (bodyVersion === null || headerVersion === null) {
    return { ok: false, status: 400, body: { error: 'Todo version must be a positive safe integer.', code: 'todo_invalid_version' } };
  }
  if (bodyVersion !== undefined && headerVersion !== undefined && bodyVersion !== headerVersion) {
    return { ok: false, status: 400, body: { error: 'Todo version preconditions do not match.', code: 'todo_invalid_version' } };
  }
  return { ok: true, expectedVersion: bodyVersion ?? headerVersion! };
}

type TodoEditValidationCode = 'todo_invalid_patch' | 'todo_invalid_assignee' | 'todo_invalid_department';

export function todoEditValidationError(
  res: ServerResponse,
  error: string,
  code: TodoEditValidationCode = 'todo_invalid_patch',
): void {
  json(res, { error, code }, 400);
}

/** `undefined` when the header is absent, `null` when it is unusable. */
export function todoEditContentLength(value: string | string[] | undefined): number | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : null;
}

export function hasSupportedTodoEditContentEncoding(value: string | string[] | undefined): boolean {
  return value === undefined || (typeof value === 'string' && value.trim().toLowerCase() === 'identity');
}
