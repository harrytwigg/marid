import type { Heartbeat } from "../heartbeats/types.js";
import type {
  BackgroundTasksReport,
  DelegatedSessionWait,
  HeartbeatWait,
  SessionWaitItem,
  SessionWaitsResponse,
} from "../shared/session-waits.js";
import type { Session } from "../shared/types.js";
import { reportingParentSessionId } from "../work-items/employee-session-delegation.js";
import { toWorkItemLinkRole } from "../work-items/link-role.js";

const HEARTBEAT_MESSAGE_MAX = 200;

/** Everything the read model needs, as values and lookups: the route supplies them from the live
 *  gateway, a test from literals. */
export interface SessionWaitsInput {
  sessionId: string;
  now: number;
  /** Every session the walk may pass through. */
  sessions: readonly Session[];
  /** The sessions holding engine capacity: the delegated-activity count's active set. */
  activeSessionIds: ReadonlySet<string>;
  /** The reported status of a session: the stored one with the background overlay applied. */
  statusOf(session: Session): DelegatedSessionWait["status"];
  /** Whether the caller may read the session (the session read route's rule). */
  canRead(session: Session): boolean;
  employeeDisplayName(employee: string): string | null;
  todoTitle(workItemId: string): string | null;
  /** The instant the session's open Todo run started, when it has one. */
  openRunStartedAt(session: Session): string | null;
  /** What the session's engine says it is waiting on. */
  engine: BackgroundTasksReport | null;
  /** The session's armed heartbeats. */
  heartbeats: readonly Heartbeat[];
  /** Who a session reports to. */
  parentOf?(session: Session): string | null;
}

/** The kinds in display order after the sessions. */
const KIND_ORDER = ["monitor", "process", "subagent", "rerun", "heartbeat"] as const;

function relationOf(session: Session): DelegatedSessionWait["relation"] {
  if (!session.workItemId) return "session";
  const role = toWorkItemLinkRole(session.workItemRole);
  return role === "review" ? "review" : role === "consult" ? "session" : "delegated";
}

/** The active sessions that report, directly or through others, to `rootId`, each with the session it
 *  reports to. The walk and its cycle containment are `buildDelegatedActivityIndex`'s: an active
 *  session counts for an ancestor reached before the chain closes on itself, and never for itself. */
function activeBelow(input: SessionWaitsInput, parentOf: (s: Session) => string | null): Map<string, string> {
  const byId = new Map(input.sessions.map((session) => [session.id, session]));
  const below = new Map<string, string>();
  for (const activeId of input.activeSessionIds) {
    const active = byId.get(activeId);
    if (!active) continue;
    const visited = new Set([active.id]);
    let parentId = parentOf(active);
    while (parentId && !visited.has(parentId)) {
      if (parentId === input.sessionId) { below.set(active.id, parentOf(active)!); break; }
      visited.add(parentId);
      const parent = byId.get(parentId);
      parentId = parent ? parentOf(parent) : null;
    }
  }
  return below;
}

/** Direct reporting children that stopped being active after this session's last turn: finished,
 *  failed or stopped, with their report not yet picked up. */
function endedChildren(input: SessionWaitsInput, parentOf: (s: Session) => string | null): Session[] {
  const self = input.sessions.find((session) => session.id === input.sessionId);
  const since = self ? Date.parse(self.lastActivity) : Number.NaN;
  return input.sessions.filter((session) =>
    session.id !== input.sessionId
    && !input.activeSessionIds.has(session.id)
    && parentOf(session) === input.sessionId
    && Date.parse(session.lastActivity) > since);
}

/** The Todo a delegated or reviewing session works, when the caller may know of it. */
function todoOf(input: SessionWaitsInput, session: Session, relation: DelegatedSessionWait["relation"]): DelegatedSessionWait["todo"] {
  if (relation === "session" || !session.workItemId) return null;
  const title = input.todoTitle(session.workItemId);
  return title === null ? null : { id: session.workItemId, title };
}

function sessionItem(input: SessionWaitsInput, session: Session, reportsTo: string): DelegatedSessionWait {
  const relation = relationOf(session);
  const restricted = !input.canRead(session);
  const active = input.activeSessionIds.has(session.id);
  const employee = restricted ? null : session.employee;
  return {
    kind: "session",
    sessionId: session.id,
    reportsTo,
    relation,
    restricted,
    employee,
    employeeDisplayName: employee ? input.employeeDisplayName(employee) : null,
    title: restricted ? null : session.title,
    todo: restricted ? null : todoOf(input, session, relation),
    status: input.statusOf(session),
    active,
    since: (session.workItemId ? input.openRunStartedAt(session) : null) ?? session.createdAt,
    endedAt: active ? null : session.lastActivity,
    archived: Boolean(session.archivedAt),
  };
}

function heartbeatItem(heartbeat: Heartbeat): HeartbeatWait {
  return {
    kind: "heartbeat",
    id: heartbeat.id,
    message: heartbeat.message.slice(0, HEARTBEAT_MESSAGE_MAX),
    everySeconds: heartbeat.everySeconds,
    nextFireAt: new Date(heartbeat.nextFireAt).toISOString(),
    fireCount: heartbeat.fireCount,
    maxFires: heartbeat.maxFires,
  };
}

/** The instant an item is ordered by within its kind. */
function orderInstant(item: SessionWaitItem): string {
  if (item.kind === "session") return item.since;
  if (item.kind === "heartbeat") return item.nextFireAt;
  return item.startedAt ?? "";
}

function itemId(item: SessionWaitItem): string {
  return item.kind === "session" ? item.sessionId : item.kind === "rerun" ? "" : item.id;
}

/** Active sessions, then inactive ones, then monitor, process, subagent, rerun, heartbeat; within a
 *  group oldest first, then by id. */
function rank(item: SessionWaitItem): number {
  if (item.kind === "session") return item.active ? 0 : 1;
  return 2 + KIND_ORDER.indexOf(item.kind);
}

function byRank(a: SessionWaitItem, b: SessionWaitItem): number {
  return rank(a) - rank(b) || orderInstant(a).localeCompare(orderInstant(b)) || itemId(a).localeCompare(itemId(b));
}

/** What one session is waiting on: the sessions working or just finished below it, the engine's
 *  background tasks and re-run, and its armed heartbeats. */
export function buildSessionWaits(input: SessionWaitsInput): SessionWaitsResponse {
  const parentOf = input.parentOf ?? reportingParentSessionId;
  const byId = new Map(input.sessions.map((session) => [session.id, session]));
  const children = new Map<string, string>(activeBelow(input, parentOf));
  for (const session of endedChildren(input, parentOf)) children.set(session.id, input.sessionId);

  const items: SessionWaitItem[] = [];
  for (const [childId, reportsTo] of children) {
    const session = byId.get(childId);
    if (session) items.push(sessionItem(input, session, reportsTo));
  }
  items.push(...(input.engine?.tasks ?? []));
  if (input.engine?.rerun) items.push({ kind: "rerun", startedAt: input.engine.rerun.startedAt });
  items.push(...input.heartbeats.map(heartbeatItem));

  return { sessionId: input.sessionId, generatedAt: new Date(input.now).toISOString(), items: items.sort(byRank) };
}
