import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { json, type ParsedRoute } from "./route-helpers.js";
import type { ApiContext } from "./api.js";
import { readTicks } from "../board-walk/store.js";
import { countStarts, listStartedSessions } from "../board-walk/started-sessions.js";
import { readClaudeUsageHistory } from "../shared/claude-usage-history.js";

/**
 * The board walk and the Auto-Dispatch page.
 *
 *   GET  /api/board-walk            the rules file's settings and problems, whether
 *                                   it is scheduled or running, and the last tick
 *   GET  /api/board-walk/ticks      the tick log, newest first
 *   POST /api/board-walk/tick       run a tick now (operator only; `?wait=1` waits
 *                                   for it, otherwise it answers 202 at once)
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

export async function handleBoardWalkApi(
  _req: HttpRequest,
  res: ServerResponse,
  route: ParsedRoute,
  context: ApiContext,
): Promise<boolean> {
  const { method, pathname, url } = route;

  if (pathname.startsWith("/api/board-walk")) {
    if (pathname === "/api/board-walk/ticks" && method === "GET") {
      json(res, { ticks: readTicks(bounded(url, "limit", 50, 500)) });
      return true;
    }
    if (!context.boardWalk) { json(res, { error: "the board walk is not running in this gateway" }, 503); return true; }
    if (pathname === "/api/board-walk" && method === "GET") {
      json(res, context.boardWalk.status());
      return true;
    }
    if (pathname === "/api/board-walk/tick" && method === "POST") {
      const ticking = context.boardWalk.tick("manual");
      if (url.searchParams.get("wait") === "1") json(res, { tick: await ticking });
      else json(res, { started: true }, 202);
      return true;
    }
    return false;
  }

  if (method !== "GET" || !pathname.startsWith("/api/auto-dispatch")) return false;

  // Every session started on the engine in the window, whatever started it —
  // the board walk, the dispatch button, a mention, cron or a chat.
  if (pathname === "/api/auto-dispatch/sessions") {
    const hours = bounded(url, "hours", 168, 168);
    const engine = url.searchParams.get("engine") || undefined;
    const sessions = listStartedSessions(Date.now() - hours * 60 * 60_000, { ...(engine ? { engine } : {}), limit: bounded(url, "limit", 500, 2000) });
    json(res, { sessions, counts: countStarts(sessions) });
    return true;
  }

  // The retained live readings, oldest first: what the page graphs and
  // projects from. Readings only — no projection leaves the gateway on this
  // wire, so nothing here can be mistaken for one.
  if (pathname === "/api/auto-dispatch/usage") {
    const hours = bounded(url, "hours", 168, 168);
    json(res, { samples: readClaudeUsageHistory(Date.now() - hours * 60 * 60_000) });
    return true;
  }

  return false;
}
