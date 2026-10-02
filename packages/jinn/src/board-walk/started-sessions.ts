import type { Session } from "../shared/types.js";
import { listSessionsCreatedSince } from "../sessions/registry.js";
import { TODO_DISPATCHER_NAME, TODO_SHAPER_NAME } from "../gateway/system-employees.js";

/**
 * "What was started on this engine, and by what?" — read straight from the
 * session registry, whatever started the session. One query serves the
 * Auto-Dispatch page's list and graph and the board walk's per-window start
 * count, so there is no second record of a start that could disagree with the
 * sessions themselves.
 */

/** Session key prefix of the walk's own turn. */
export const BOARD_WALK_SESSION_KEY_PREFIX = "board-walk:";
/** `transportMeta.startedBy` on a Dispatcher session the walk started. */
export const BOARD_WALK_STARTED_BY = "board-walk";

export type StartedBy =
  | "board-walk-dispatch"
  | "board-walk"
  | "dispatch"
  | "capture"
  | "cron"
  | "delegated"
  | "chat";

export interface StartedSession {
  id: string;
  engine: string;
  model: string | null;
  employee: string | null;
  title: string | null;
  source: string;
  status: Session["status"];
  createdAt: string;
  startedBy: StartedBy;
}

/** What started a session, as far as the registry already knows. */
export function startedBy(session: Session): StartedBy {
  if (session.transportMeta?.startedBy === BOARD_WALK_STARTED_BY) return "board-walk-dispatch";
  const key = session.sessionKey ?? session.sourceRef ?? "";
  if (key.startsWith(BOARD_WALK_SESSION_KEY_PREFIX)) return "board-walk";
  if (session.employee === TODO_DISPATCHER_NAME) return "dispatch";
  if (session.employee === TODO_SHAPER_NAME) return "capture";
  if (session.source === "cron") return "cron";
  if (session.parentSessionId) return "delegated";
  return "chat";
}

export function toStartedSession(session: Session): StartedSession {
  return {
    id: session.id,
    engine: session.engine,
    model: session.model ?? null,
    employee: session.employee ?? null,
    title: session.title ?? null,
    source: session.source,
    status: session.status,
    createdAt: session.createdAt,
    startedBy: startedBy(session),
  };
}

export function listStartedSessions(sinceMs: number, opts: { engine?: string; limit?: number } = {}): StartedSession[] {
  return listSessionsCreatedSince(new Date(sinceMs).toISOString(), opts).map(toStartedSession);
}

export type StartCounts = Partial<Record<StartedBy, number>> & { total: number };

export function countStarts(sessions: readonly StartedSession[]): StartCounts {
  const counts: StartCounts = { total: sessions.length };
  for (const session of sessions) counts[session.startedBy] = (counts[session.startedBy] ?? 0) + 1;
  return counts;
}
