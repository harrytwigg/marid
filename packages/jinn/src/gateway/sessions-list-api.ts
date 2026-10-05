import type { ServerResponse } from "node:http";
import {
  getSessionGroupCounts,
  listPinnedSessions,
  listRecentPerGroup,
  listSessions,
  listSessionsForGroup,
  searchSessions,
} from "../sessions/registry.js";
import type { Session } from "../shared/types.js";
import { json, type ParsedRoute } from "./route-helpers.js";

const SESSION_LIST_PER_GROUP = 50;

export interface SessionsListOptions {
  /** api.ts's live serialisation of a session list: it reads per-request runtime state. */
  serialize: (sessions: readonly Session[]) => Session[];
  /** The portal slug: portal-tagged rows fold into the direct group. */
  portalSlug: string | undefined;
}

/**
 * GET /api/sessions
 *   ?group=<employee|__direct__|__cron__>&offset=M&limit=N → one group's page (sidebar "load more")
 *   ?pinned=1                                           → pinned, non-archived sessions
 *   ?q=<text>                                           → sessions matching the text
 *   ?limit=0                                              → every session (power-user escape hatch)
 *   (default)                                             → top SESSION_LIST_PER_GROUP recent per group + counts
 *
 * Moved out of api.ts, which is over its size budget.
 */
/** The body for `?pinned`, `?q`, `?group` or `?limit=0`, or undefined for the default listing. */
function selectedList(params: URLSearchParams, { serialize, portalSlug }: SessionsListOptions): Session[] | undefined {
  if (params.get("pinned") === "1") return serialize(listPinnedSessions());
  const query = params.get("q")?.trim();
  if (query) return serialize(searchSessions(query));
  const group = params.get("group");
  if (group) {
    const limit = Math.max(1, parseInt(params.get("limit") || "50", 10) || 50);
    const offset = Math.max(0, parseInt(params.get("offset") || "0", 10) || 0);
    return serialize(listSessionsForGroup(group, limit, offset, portalSlug));
  }
  return params.get("limit") === "0" ? serialize(listSessions()) : undefined;
}

export async function handleSessionsListApi(res: ServerResponse, route: ParsedRoute, options: SessionsListOptions): Promise<boolean> {
  if (route.method !== "GET" || route.pathname !== "/api/sessions") return false;
  const selected = selectedList(route.url.searchParams, options);
  json(res, selected ?? {
    sessions: options.serialize(listRecentPerGroup(SESSION_LIST_PER_GROUP, options.portalSlug)),
    counts: getSessionGroupCounts(options.portalSlug),
    perGroup: SESSION_LIST_PER_GROUP,
  });
  return true;
}
