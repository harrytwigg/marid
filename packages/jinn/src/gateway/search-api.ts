import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { runGlobalSearch } from "../search/global-search.js";
import { SEARCH_KINDS, type SearchKind } from "../search/types.js";
import {
  searchMessages,
  searchSessionsFiltered,
  type MessageSearchFilter,
  type SearchSessionsFilter,
} from "../sessions/registry.js";
import { JINN_HOME } from "../shared/paths.js";
import type { Session } from "../shared/types.js";
import { queryWorkItems, type ListWorkItemsFilter } from "../work-items/store.js";

/** Whose attention queue a list reads, as the route resolved it. */
export type NeedsAttentionTarget = Pick<ListWorkItemsFilter, "needsAttentionFor" | "needsAttentionOperator">;
import type { ApiContext } from "./api.js";
import { badRequest, json, type ParsedRoute } from "./route-helpers.js";
import { workItemPagePayload } from "./work-item-payload.js";
import { readCleanSearchParam, readWorkItemQueryParams, SEARCH_QUERY_ROUTE_CHAR_CAP } from "./work-item-query.js";

/** `/api/search*` routes. See route-helpers.ts for the domain-module contract.
 *
 *  The three per-entity searches moved here unchanged when `/api/search/global`
 *  was added: api.ts sits exactly at its size budget and cannot gain even the
 *  one line a new route needs, so the four routes live together instead. Their
 *  responses are byte-identical to what api.ts returned, and their existing
 *  suites are what says so. */

/** Each reader either fills its shape or says why it could not — an unusable
 *  parameter is an explicit 400, never a silently ignored filter. */
type ReadResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface SearchApiOptions {
  context: ApiContext;
  /** The reference-layer session shape, owned by api.ts and shared with the
   *  routes that predate this module. */
  compactSessionSummary: (session: Session) => Record<string, unknown>;
  /** Request-bound authority check. It answers on the response itself and
   *  returns undefined once it has; the caller-identity machinery it needs
   *  stays in api.ts. */
  resolveNeedsAttentionTarget: (requested: string) => NeedsAttentionTarget | undefined;
}

export function messageSearchFilter(url: URL): ReadResult<MessageSearchFilter> {
  const filter: MessageSearchFilter = {};
  for (const name of ["sessionId", "excludeSessionId", "employee", "engine"] as const) {
    const value = readCleanSearchParam(url, name);
    if (value) filter[name] = value;
  }
  const role = readCleanSearchParam(url, "role");
  if (role) {
    if (role !== "user" && role !== "assistant") {
      return { ok: false, error: `role must be "user" or "assistant" (only those rows are indexed), got "${role}"` };
    }
    filter.role = role;
  }
  for (const param of ["since", "until"] as const) {
    const raw = readCleanSearchParam(url, param);
    if (raw) {
      const ms = Date.parse(raw);
      if (Number.isNaN(ms)) return { ok: false, error: `${param} must be an ISO-8601 timestamp, got "${raw}"` };
      filter[param] = ms;
    }
  }
  return { ok: true, value: filter };
}

/**
 * GET /api/search/messages — GRS-020a company-reference search: FTS5 over
 * user/assistant message bodies (injection-safe — the store sanitizes the
 * query into quoted phrases), AND-composed bound-param filters, newest-first.
 * GRS-020a-fix hardening: control bytes are stripped from every string param
 * (an embedded NUL made FTS5 throw — finding 2) and the query length is
 * capped route-side (finding 3; the MCP tools cap earlier and friendlier).
 */
function searchMessagesRoute(res: ServerResponse, url: URL): void {
  const q = readCleanSearchParam(url, "q");
  if (!q) return badRequest(res, "q is required");
  if (q.length > SEARCH_QUERY_ROUTE_CHAR_CAP) {
    return badRequest(res, `q is too long (${q.length} chars, max ${SEARCH_QUERY_ROUTE_CHAR_CAP}) — shorten the query`);
  }
  const filter = messageSearchFilter(url);
  if (!filter.ok) return badRequest(res, filter.error);
  const limit = Math.max(1, Math.min(parseInt(url.searchParams.get("limit") || "20", 10) || 20, 200));
  return json(res, { query: q, results: searchMessages(q, limit, filter.value) });
}

/** Fills the `last_activity` bounds, or names the one it could not read — the
 *  `FilterReader` idiom work-item-query.ts already uses. */
function readSessionWindow(url: URL, filter: SearchSessionsFilter): string | undefined {
  for (const key of ["activeSince", "activeBefore"] as const) {
    const raw = readCleanSearchParam(url, key);
    if (raw) {
      if (Number.isNaN(Date.parse(raw))) return `${key} must be an ISO-8601 timestamp, got "${raw}"`;
      filter[key] = new Date(raw).toISOString();
    }
  }
  return undefined;
}

export function sessionSearchFilter(url: URL): ReadResult<SearchSessionsFilter> {
  const filter: SearchSessionsFilter = {};
  const text = readCleanSearchParam(url, "text");
  if (text) {
    if (text.length > SEARCH_QUERY_ROUTE_CHAR_CAP) {
      return { ok: false, error: `text is too long (${text.length} chars, max ${SEARCH_QUERY_ROUTE_CHAR_CAP}) — shorten the query` };
    }
    filter.text = text;
  }
  const status = readCleanSearchParam(url, "status");
  if (status) {
    const valid: Session["status"][] = ["idle", "running", "error", "waiting", "interrupted"];
    if (!valid.includes(status as Session["status"])) {
      return { ok: false, error: `status must be one of ${valid.join(", ")}, got "${status}"` };
    }
    filter.status = status as Session["status"];
  }
  for (const name of ["employee", "engine", "source", "parentSessionId"] as const) {
    const value = readCleanSearchParam(url, name);
    if (value) filter[name] = value;
  }
  const window = readSessionWindow(url, filter);
  if (window) return { ok: false, error: window };
  if (url.searchParams.get("needsAttention") === "true") filter.needsAttention = true;
  return { ok: true, value: filter };
}

/**
 * GET /api/search/sessions — GRS-020a: deterministic AND-composed session
 * search (escaped-LIKE text over title/prompt_excerpt/id + structured
 * filters). At least one filter required — the unbounded list stays on
 * GET /api/sessions. Returns COMPACT summaries only (GRS-020a-fix finding
 * 5: the reference layer's route contract is summaries, not the full
 * serialized session); string params are control-stripped and the text
 * filter is length-capped (findings 2+3).
 */
function searchSessionsRoute(res: ServerResponse, url: URL, options: SearchApiOptions): void {
  const filter = sessionSearchFilter(url);
  if (!filter.ok) return badRequest(res, filter.error);
  if (Object.keys(filter.value).length === 0) {
    return badRequest(res, "at least one filter is required (text, employee, engine, status, source, parentSessionId, activeSince, activeBefore, needsAttention)");
  }
  const limit = Math.max(1, Math.min(parseInt(url.searchParams.get("limit") || "20", 10) || 20, 50));
  const sessions = searchSessionsFiltered(filter.value, limit);
  return json(res, { sessions: sessions.map(options.compactSessionSummary) });
}

/**
 * GET /api/search/work-items — GRS-021c: deterministic AND-composed Todo
 * search. Text is matched by the FTS5 indexes over title, body and comments and
 * structured filters are exact. Compact summaries only — body
 * dumps stay behind GET /api/work-items/:id.
 */
function searchWorkItemsRoute(res: ServerResponse, url: URL, options: SearchApiOptions): void {
  const parsedQuery = readWorkItemQueryParams(url);
  if (!parsedQuery.ok) return badRequest(res, parsedQuery.error);
  const { filter, limit, offset } = parsedQuery.value;
  const needsAttentionFor = readCleanSearchParam(url, "needsAttentionFor");
  if (needsAttentionFor) {
    const target = options.resolveNeedsAttentionTarget(needsAttentionFor);
    if (!target) return;
    Object.assign(filter, target);
  }
  if (Object.keys(filter).length === 0) {
    return badRequest(res, "at least one filter is required (q, text, status, source, assignee, department, since, until, needsAttentionFor)");
  }
  return json(res, workItemPagePayload(queryWorkItems({ ...filter, limit, offset })));
}

interface GlobalSearchParams {
  query: string;
  scope?: SearchKind;
  literal: boolean;
  limit: number;
}

const GLOBAL_SEARCH_DEFAULT_LIMIT = 10;
const GLOBAL_SEARCH_MAX_LIMIT = 50;

/** The kind, or undefined when unscoped, or null when the value names nothing.
 *  A plural is accepted because the surface that sends this spells it that way:
 *  the Todos search box enters the overlay with `scope=todos`. */
function readScope(url: URL): SearchKind | undefined | null {
  const raw = readCleanSearchParam(url, "scope");
  if (!raw) return undefined;
  const singular = raw.endsWith("s") ? raw.slice(0, -1) : raw;
  if ((SEARCH_KINDS as readonly string[]).includes(raw)) return raw as SearchKind;
  if ((SEARCH_KINDS as readonly string[]).includes(singular)) return singular as SearchKind;
  return null;
}

function readGlobalSearchParams(url: URL): ReadResult<GlobalSearchParams> {
  const query = readCleanSearchParam(url, "q");
  if (!query) return { ok: false, error: "q is required" };
  if (query.length > SEARCH_QUERY_ROUTE_CHAR_CAP) {
    return { ok: false, error: `q is too long (${query.length} chars, max ${SEARCH_QUERY_ROUTE_CHAR_CAP}) — shorten the query` };
  }
  const scope = readScope(url);
  if (scope === null) return { ok: false, error: `scope must be one of ${SEARCH_KINDS.join(", ")}, got "${readCleanSearchParam(url, "scope")}"` };
  const raw = url.searchParams.get("limit");
  if (raw !== null && !/^\d+$/.test(raw.trim())) return { ok: false, error: "limit must be a non-negative integer" };
  const limit = raw === null
    ? GLOBAL_SEARCH_DEFAULT_LIMIT
    : Math.max(1, Math.min(Number(raw.trim()) || GLOBAL_SEARCH_DEFAULT_LIMIT, GLOBAL_SEARCH_MAX_LIMIT));
  return {
    ok: true,
    value: { query, ...(scope ? { scope } : {}), literal: readCleanSearchParam(url, "literal") === "true", limit },
  };
}

/**
 * GET /api/search/global — ICI-1370: one query, ranked results across Todos,
 * sessions, notes, people, cron jobs, skills and nav pages, each carrying why
 * it matched and a preview payload. The query grammar reads plain words and
 * explicit tokens both, and reports back how it understood them.
 */
function searchGlobalRoute(res: ServerResponse, url: URL, options: SearchApiOptions): void {
  const params = readGlobalSearchParams(url);
  if (!params.ok) return badRequest(res, params.error);
  const outcome = runGlobalSearch({
    ...params.value,
    config: options.context.getConfig(),
    home: options.context.jinnHome ?? JINN_HOME,
  });
  if (!outcome.ok) return badRequest(res, outcome.error);
  return json(res, outcome.value);
}

export async function handleSearchApi(
  _req: HttpRequest,
  res: ServerResponse,
  route: ParsedRoute,
  options: SearchApiOptions,
): Promise<boolean> {
  const { method, pathname, url } = route;
  if (method !== "GET") return false;
  if (pathname === "/api/search/messages") searchMessagesRoute(res, url);
  else if (pathname === "/api/search/sessions") searchSessionsRoute(res, url, options);
  else if (pathname === "/api/search/work-items") searchWorkItemsRoute(res, url, options);
  else if (pathname === "/api/search/global") searchGlobalRoute(res, url, options);
  else return false;
  return true;
}
