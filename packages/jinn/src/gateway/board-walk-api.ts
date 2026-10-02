import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { json, type ParsedRoute } from "./route-helpers.js";
import type { ApiContext } from "./api.js";
import { readTicks } from "../board-walk/store.js";
import { countStarts, listStartedSessions } from "../board-walk/started-sessions.js";
import { readClaudeUsageHistory } from "../shared/claude-usage-history.js";
import { getSession } from "../sessions/registry.js";
import { verifySessionCapability } from "../mcp/identity.js";
import { readJsonBody } from "./http-helpers.js";
import { resolveCallerIdentity } from "./session-comm-guards.js";

/**
 * The board walk and the Auto-Dispatch page.
 *
 *   GET  /api/board-walk            the rules file's settings and problems, whether
 *                                   it is scheduled or running, and the last tick
 *   GET  /api/board-walk/ticks      the tick log, newest first
 *   POST /api/board-walk/tick       run a tick now (operator only; `?wait=1` waits
 *                                   for it, otherwise it answers 202 at once)
 *   POST /api/board-walk/turn/<tool>  one call from the walk's own tools
 *                                   (mcp/board-walk-tools.ts): only from the
 *                                   running tick's session, bound by its capability
 *   GET  /api/auto-dispatch/sessions  sessions started per engine, from the
 *                                   session registry, whatever started them
 *   GET  /api/auto-dispatch/usage   the retained Claude readings the graph draws
 *
 * Nothing here edits a policy: the dispatch rules are prose in board-walk.md.
 * See route-helpers.ts for the domain-module contract.
 */

/** A query number, or the default; clamped so a caller cannot ask for everything. */
function bounded(url: URL, key: string, fallback: number, max: number): number {
  const raw = Number(url.searchParams.get(key));
  return Number.isFinite(raw) && raw > 0 ? Math.min(max, raw) : fallback;
}

const TURN_TOOL_PREFIX = "/api/board-walk/turn/";

/** A walk tool's call: answered only for a caller that proves which session it
 *  is, and the walk then answers only its running tick's own session. */
async function handleTurnTool(req: HttpRequest, res: ServerResponse, route: ParsedRoute, context: ApiContext): Promise<true> {
  const walk = context.boardWalk;
  if (!walk) { json(res, { error: "the board walk is not running in this gateway" }, 503); return true; }
  const identity = resolveCallerIdentity(req.headers, { sessionExists: (id) => !!getSession(id), verifySessionCapability, requireCapability: true });
  if (identity.kind !== "session") {
    json(res, { error: "the walk's tools answer only a session that proves which one it is" }, 403);
    return true;
  }
  const parsed = await readJsonBody(req, res);
  if (!parsed.ok) return true;
  const args = parsed.body && typeof parsed.body === "object" && !Array.isArray(parsed.body) ? parsed.body as Record<string, unknown> : {};
  const answer = await walk.turnTool(identity.callerId, route.pathname.slice(TURN_TOOL_PREFIX.length), args);
  json(res, answer.body, answer.status);
  return true;
}

async function handleWalk(res: ServerResponse, route: ParsedRoute, context: ApiContext): Promise<boolean> {
  const { method, pathname, url } = route;
  if (pathname === "/api/board-walk/ticks" && method === "GET") {
    json(res, { ticks: readTicks(bounded(url, "limit", 50, 500)) });
    return true;
  }
  const walk = context.boardWalk;
  if (!walk) { json(res, { error: "the board walk is not running in this gateway" }, 503); return true; }
  if (pathname === "/api/board-walk" && method === "GET") {
    json(res, walk.status());
    return true;
  }
  if (pathname === "/api/board-walk/tick" && method === "POST") {
    const ticking = walk.tick("manual");
    if (url.searchParams.get("wait") === "1") json(res, { tick: await ticking });
    else json(res, { started: true }, 202);
    return true;
  }
  return false;
}

function handleAutoDispatch(res: ServerResponse, route: ParsedRoute): boolean {
  const { pathname, url } = route;
  const since = Date.now() - bounded(url, "hours", 168, 168) * 60 * 60_000;
  // Every session started on the engine in the window, whatever started it —
  // the board walk, the dispatch button, a mention, cron or a chat.
  if (pathname === "/api/auto-dispatch/sessions") {
    const engine = url.searchParams.get("engine") || undefined;
    const sessions = listStartedSessions(since, { ...(engine ? { engine } : {}), limit: bounded(url, "limit", 500, 2000) });
    json(res, { sessions, counts: countStarts(sessions) });
    return true;
  }
  // The retained live readings, oldest first: what the page graphs and
  // projects from. Readings only — no projection leaves the gateway on this
  // wire, so nothing here can be mistaken for one.
  if (pathname === "/api/auto-dispatch/usage") {
    json(res, { samples: readClaudeUsageHistory(since) });
    return true;
  }
  return false;
}

export async function handleBoardWalkApi(
  req: HttpRequest,
  res: ServerResponse,
  route: ParsedRoute,
  context: ApiContext,
): Promise<boolean> {
  if (route.method === "POST" && route.pathname.startsWith(TURN_TOOL_PREFIX)) return handleTurnTool(req, res, route, context);
  if (route.pathname.startsWith("/api/board-walk")) return handleWalk(res, route, context);
  if (route.method === "GET" && route.pathname.startsWith("/api/auto-dispatch")) return handleAutoDispatch(res, route);
  return false;
}
