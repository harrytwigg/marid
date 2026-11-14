import type { ServerResponse } from "node:http";
import type { Engine, Session } from "../shared/types.js";
import { listHeartbeatsForSession } from "../heartbeats/store.js";
import { getSession, listChildSessions, listSessions } from "../sessions/registry.js";
import { buildSessionWaits } from "../sessions/session-waits.js";
import { isBackgroundTasksSource, type BackgroundTasksReport } from "../shared/session-waits.js";
import { findOpenWorkItemRunBySession } from "../work-items/runs.js";
import { getWorkItem } from "../work-items/store.js";
import { json, matchRoute, notFound, type ParsedRoute } from "./route-helpers.js";

export interface SessionWaitsDeps {
  /** The sessions among `sessions` holding engine capacity: the delegated-activity count's active set. */
  holdingCapacity(sessions: readonly Session[]): Session[];
  /** The status the session list reports for it. */
  statusOf(session: Session): Session["status"];
  /** The engines that may hold the session's background tasks. */
  engines(session: Session): Array<Engine | undefined>;
  employeeDisplayName(employee: string): string | null;
  /** The department a scoped caller is held to, or null for anyone unscoped. */
  callerDepartment(): string | null;
}

/** What the session's engines report, merged: a task or re-run any of them holds is open. */
function engineReport(session: Session, deps: SessionWaitsDeps): BackgroundTasksReport | null {
  const merged: BackgroundTasksReport = { tasks: [] };
  const seen = new Set<string>();
  let reported = false;
  for (const engine of new Set(deps.engines(session))) {
    if (!engine || !isBackgroundTasksSource(engine)) continue;
    reported = true;
    const report = engine.backgroundTasks(session.id);
    for (const task of report.tasks) if (!seen.has(task.id)) { seen.add(task.id); merged.tasks.push(task); }
    if (report.rerun) merged.rerun = report.rerun;
  }
  return reported ? merged : null;
}

/** The sessions the walk passes through: every unarchived session, plus the session itself and its own
 *  children (archived ones included, so a child archived after it finished still reads as finished, and
 *  an archived or workflow-phase session still has its own last activity to measure them against). */
function walkedSessions(session: Session): Session[] {
  const all = listSessions();
  const known = new Set(all.map((listed) => listed.id));
  return [...all, ...[session, ...listChildSessions(session.id)].filter((extra) => !known.has(extra.id))];
}

/**
 * GET /api/sessions/:id/waits: what the session is waiting on, item by item. The session payloads
 * carry counts only; the "waiting on" popup fetches this while it is open. A session the caller
 * could not read through `GET /api/sessions/:id` answers 404, and a child it could not read is
 * listed as restricted with its details withheld. Moved out of api.ts, which is over its size budget.
 */
export function handleSessionWaitsApi(res: ServerResponse, route: ParsedRoute, deps: SessionWaitsDeps): boolean {
  const params = route.method === "GET" ? matchRoute("/api/sessions/:id/waits", route.pathname) : null;
  if (!params) return false;
  const department = deps.callerDepartment();
  const readable = (session: Session) => department === null || session.scopeDepartment === department;
  const session = getSession(params.id);
  if (!session || !readable(session)) {
    notFound(res);
    return true;
  }
  const sessions = walkedSessions(session);
  json(res, buildSessionWaits({
    sessionId: session.id,
    now: Date.now(),
    sessions,
    activeSessionIds: new Set(deps.holdingCapacity(sessions).map((held) => held.id)),
    statusOf: deps.statusOf,
    canRead: readable,
    employeeDisplayName: deps.employeeDisplayName,
    // The redactor withholds another department's Todo id but not free text, so its title is withheld here.
    todoTitle: (workItemId) => {
      const item = getWorkItem(workItemId);
      return item && (department === null || item.department === department) ? item.title : null;
    },
    openRunStartedAt: (child) => findOpenWorkItemRunBySession(child.id)?.startedAt ?? null,
    engine: engineReport(session, deps),
    heartbeats: listHeartbeatsForSession(session.id),
  }));
  return true;
}
