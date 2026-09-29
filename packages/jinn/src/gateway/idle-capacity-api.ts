import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { resolveIdleCapacityPolicy } from "../shared/idle-capacity-config.js";
import { CONFIG_REVISION_HEADER, currentConfigRevision } from "./config-revision.js";
import { json, type ParsedRoute } from "./route-helpers.js";
import type { ApiContext } from "./api.js";
import { HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT, listIdleCapacityStarts } from "./idle-capacity-history.js";
import { readClaudeUsageHistory } from "../shared/claude-usage-history.js";

/**
 * The idle-capacity auto-start's read-only face (preview
 * dashboard). Every route here reads; the one write the dashboard makes — the
 * policy block — goes through `PUT /api/config` like any other config edit, so
 * there is exactly one config writer to get right.
 *
 * See route-helpers.ts for the domain-module contract.
 */

const BASE = "/api/idle-capacity";

/** A query number, or the default; clamped so a caller cannot ask for everything. */
function bounded(url: URL, key: string, fallback: number, max: number): number {
  const raw = Number(url.searchParams.get(key));
  return Number.isFinite(raw) && raw > 0 ? Math.min(max, raw) : fallback;
}

export async function handleIdleCapacityApi(
  _req: HttpRequest,
  res: ServerResponse,
  route: ParsedRoute,
  context: ApiContext,
): Promise<boolean> {
  if (route.method !== "GET" || !route.pathname.startsWith(BASE)) return false;

  // What the loop would do on its next tick and why: policy, the live verdict
  // against the account's Claude windows, and the backlog it would choose
  // from. It never starts anything, so the operator can watch the reasoning
  // safely — but it does run the collector, so it is not the form's seed.
  if (route.pathname === BASE) {
    if (!context.idleCapacity) { json(res, { error: "the idle-capacity loop is not running in this gateway" }, 503); return true; }
    json(res, await context.idleCapacity.preview());
    return true;
  }

  // The policy as the loop resolves it — every key explicit — beside the raw
  // block the file holds, stamped with the file's revision exactly as
  // GET /api/config stamps it. One response, so the form the dashboard edits
  // and the revision it saves against can never come from two file states.
  if (route.pathname === `${BASE}/policy`) {
    const raw = context.getConfig().gateway.idleCapacity;
    res.setHeader(CONFIG_REVISION_HEADER, currentConfigRevision());
    json(res, { policy: resolveIdleCapacityPolicy(raw), configured: raw ?? null });
    return true;
  }

  if (route.pathname === `${BASE}/history`) {
    json(res, { starts: listIdleCapacityStarts({ limit: bounded(route.url, "limit", HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT) }) });
    return true;
  }

  // The retained live readings, oldest first: what the dashboard graphs and
  // projects from. Readings only — no projection leaves the gateway, so nothing
  // on this wire can be mistaken for one (FR-001).
  if (route.pathname === `${BASE}/usage`) {
    const hours = bounded(route.url, "hours", 168, 168);
    json(res, { samples: readClaudeUsageHistory(Date.now() - hours * 60 * 60_000) });
    return true;
  }

  return false;
}
