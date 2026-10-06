import type { ServerResponse } from "node:http";
import { getSession } from "../../sessions/registry.js";
import { isTodoId } from "../../work-items/id.js";
import { getWorkItem } from "../../work-items/store.js";
import type { ResWithEncoding } from "../route-helpers.js";
import type { ScopedCaller } from "./caller.js";
import { scopeDepartmentOfTodo } from "./gate.js";

/**
 * The backstop behind the gate's per-route narrowing (FR-009, FR-011): whatever a route
 * answers a scoped session, no session outside its department and no Todo outside it
 * is named in the answer. Routes carry ids in many structured places (an event's actor
 * and detail, a run, a Todo's `sourceRef`, a comment's session, a tree's keys), and
 * narrowing each one by hand is where one is missed.
 *
 * Every successful JSON answer to a scoped caller is rewritten before it is sent: a
 * session id that is not bound to the department (the caller's own requester excepted,
 * which it already knows and may reply to) and an existing Todo id outside the
 * department become `hidden`, and an object entry keyed by one is dropped. Free text the
 * department's own people wrote (titles, bodies, comment and message text) is left as
 * written. Error answers are left alone, so an out-of-department id still answers
 * exactly as an unknown one.
 */

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const WHOLE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TODO = /\b[A-Z][A-Z0-9]{1,9}-[1-9][0-9]*\b/g;
const FREE_TEXT = new Set(["title", "body", "content", "text", "snippet", "promptExcerpt", "prompt", "message", "displayMessage", "persona", "description"]);
export const HIDDEN = "hidden";

export interface Redactor {
  (value: unknown): unknown;
}

export function departmentRedactor(caller: Pick<ScopedCaller, "department" | "session">): Redactor {
  const verdicts = new Map<string, boolean>();
  const hideSession = (id: string): boolean => {
    const key = id.toLowerCase();
    if (!verdicts.has(key)) {
      const session = getSession(key);
      verdicts.set(key, !!session && session.scopeDepartment !== caller.department && session.id !== caller.session.parentSessionId);
    }
    return verdicts.get(key)!;
  };
  const hideTodo = (id: string): boolean => {
    if (!verdicts.has(id)) {
      const item = isTodoId(id) ? getWorkItem(id) : undefined;
      verdicts.set(id, !!item && scopeDepartmentOfTodo(item) !== caller.department);
    }
    return verdicts.get(id)!;
  };
  const scrub = (text: string): string =>
    text.replace(UUID, (id) => (hideSession(id) ? HIDDEN : id)).replace(TODO, (id) => (hideTodo(id) ? HIDDEN : id));
  const hiddenKey = (key: string): boolean => (WHOLE_UUID.test(key) && hideSession(key)) || (isTodoId(key) && hideTodo(key));
  const walk = (value: unknown, key?: string): unknown => {
    if (typeof value === "string") return key && FREE_TEXT.has(key) ? value : scrub(value);
    if (Array.isArray(value)) return value.map((entry) => walk(entry, key));
    if (!value || typeof value !== "object") return value;
    const out: Record<string, unknown> = {};
    for (const [entryKey, entry] of Object.entries(value)) {
      if (hiddenKey(entryKey)) continue;
      out[entryKey] = walk(entry, entryKey);
    }
    return out;
  };
  return (value) => walk(value);
}

/**
 * Route every JSON answer on `res` through `redact` before it is written. Compression is
 * switched off for the request so the body can be read back; a non-JSON or error answer
 * passes through untouched.
 */
export function redactResponses(res: ServerResponse, redact: Redactor): void {
  (res as ResWithEncoding).__acceptEncoding = undefined;
  let status: number | undefined;
  let type = "";
  const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => ServerResponse;
  res.writeHead = ((code: number, ...rest: unknown[]) => {
    status = code;
    const headers = rest.find((arg) => arg && typeof arg === "object") as Record<string, unknown> | undefined;
    const declared = headers ? Object.entries(headers).find(([name]) => name.toLowerCase() === "content-type")?.[1] : undefined;
    if (declared !== undefined) type = String(declared);
    return writeHead(code, ...rest);
  }) as typeof res.writeHead;
  const end = res.end.bind(res) as (...args: unknown[]) => ServerResponse;
  const isJsonSuccess = (): boolean => {
    const declared = type || String((typeof res.getHeader === "function" && res.getHeader("content-type")) || "");
    const code = status ?? res.statusCode ?? 200;
    return code >= 200 && code < 300 && declared.includes("application/json");
  };
  res.end = ((chunk?: unknown, ...rest: unknown[]) => {
    const body = Buffer.isBuffer(chunk) || typeof chunk === "string" ? chunk : undefined;
    return end(body !== undefined && isJsonSuccess() ? redactBody(body, redact) : chunk, ...rest);
  }) as typeof res.end;
}

/** A JSON body with `redact` applied; one that does not parse is sent as it is. */
function redactBody(body: Buffer | string, redact: Redactor): Buffer | string {
  try {
    return Buffer.from(JSON.stringify(redact(JSON.parse(Buffer.isBuffer(body) ? body.toString("utf-8") : body))));
  } catch {
    return body;
  }
}
