import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { readJsonBody } from "./http-helpers.js";
import { badRequest, json, matchRoute, notFound, type ParsedRoute } from "./route-helpers.js";
import type { WorkItemCaller } from "./work-item-arming.js";
import { initDb } from "../shared/db.js";
import { isTodoId } from "../work-items/id.js";
import { setWorkItemKept } from "../work-items/kept.js";
import { appendWorkItemEvent, getWorkItem } from "../work-items/store.js";

/**
 * `PUT /api/work-items/:id/kept` — the operator's Home board.
 *
 * Operator-only. Home is the operator's own board, so an employee session
 * pinning onto it would be putting work in front of a person who never asked
 * for it. That is role scope rather than a security boundary: nothing an agent
 * can reach through this route is otherwise protected.
 *
 * See route-helpers.ts for the domain-module contract. The caller resolution
 * and the projection signal arrive as options because api.ts keeps both
 * module-private, and importing them back would close a cycle.
 */

export interface WorkItemKeptApiOptions {
  /** api.ts's work-item caller resolution; undefined once it has answered. */
  resolveCaller: () => WorkItemCaller | undefined;
  /** Tell the live surfaces this Todo's projections changed. */
  emitProjection: (id: string) => void;
}

/** The Todo this request may act on, or undefined once the route has already
 *  answered: 403 for anyone but the operator, 400 for a malformed id, 404 for
 *  one that names nothing. */
function keepableTodo(res: ServerResponse, id: string, options: WorkItemKeptApiOptions): string | undefined {
  const caller = options.resolveCaller();
  if (!caller) return undefined;
  if (caller.kind !== "operator") {
    json(res, { error: "keeping a Todo on Home requires the authenticated operator surface" }, 403);
    return undefined;
  }
  if (!isTodoId(id)) {
    badRequest(res, "Invalid Todo ID; expected <AAA>-N with a positive safe-integer suffix");
    return undefined;
  }
  if (!getWorkItem(id)) {
    notFound(res);
    return undefined;
  }
  return id;
}

export async function handleWorkItemKeptApi(
  req: HttpRequest,
  res: ServerResponse,
  route: ParsedRoute,
  options: WorkItemKeptApiOptions,
): Promise<boolean> {
  const params = matchRoute("/api/work-items/:id/kept", route.pathname);
  if (route.method !== "PUT" || !params) return false;
  const id = keepableTodo(res, params.id, options);
  if (!id) return true;
  const parsed = await readJsonBody(req, res);
  if (!parsed.ok) return true;
  const kept = (parsed.body as Record<string, unknown> | null)?.kept;
  if (typeof kept !== "boolean") {
    badRequest(res, "kept must be a boolean");
    return true;
  }
  // Silent on a repeat: re-keeping a kept Todo is not something to audit.
  if (setWorkItemKept(initDb(), id, kept)) {
    appendWorkItemEvent({ workItemId: id, kind: "kept_changed", actor: "operator", detail: { kept }, versionEffect: "audit" });
    options.emitProjection(id);
  }
  json(res, { kept });
  return true;
}
