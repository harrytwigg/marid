import { getSession } from "../sessions/registry.js";
import type { WorkItemComment } from "../work-items/comments.js";
import type { WorkItem, WorkItemEvent } from "../work-items/store.js";
import type { HookActor } from "./types.js";

const SESSION_ACTOR = "session:";

function stringDetail(event: WorkItemEvent, key: string): string | undefined {
  const value = event.detail?.[key];
  return typeof value === "string" && value ? value : undefined;
}

/** The session behind a write: a `session:<id>` actor, or the session a comment records. */
function actorSessionId(event: WorkItemEvent, comment: WorkItemComment | undefined): string | undefined {
  if (comment?.sessionId) return comment.sessionId;
  return event.actor?.startsWith(SESSION_ACTOR) ? event.actor.slice(SESSION_ACTOR.length) : undefined;
}

function employeeOf(
  event: WorkItemEvent,
  comment: WorkItemComment | undefined,
  sessionId: string | undefined,
): string | undefined {
  const named = stringDetail(event, "actorEmployee");
  if (named) return named;
  const fromSession = sessionId ? getSession(sessionId)?.employee : undefined;
  if (fromSession) return fromSession;
  return comment?.authorKind === "employee" ? comment.author : undefined;
}

function isOperator(event: WorkItemEvent, comment: WorkItemComment | undefined): boolean {
  return comment ? comment.authorKind === "operator" : event.actor === "operator";
}

/**
 * Who made the write, in the three kinds a matcher knows. The operator is the
 * operator; anything a known employee did (by `actorEmployee`, by the session's
 * employee, or as a comment's employee author) is that employee; everything else,
 * including the reconciler and a session with no employee, is `system`.
 */
export function actorOf(event: WorkItemEvent, comment?: WorkItemComment): HookActor {
  const sessionId = actorSessionId(event, comment);
  const raw = comment ? comment.author : event.actor;
  const base = { raw, ...(sessionId ? { sessionId } : {}) };
  if (isOperator(event, comment)) return { ...base, kind: "operator" };
  const employee = employeeOf(event, comment, sessionId);
  return employee ? { ...base, kind: "employee", employee } : { ...base, kind: "system" };
}

const HUMAN_CREATOR = "operator";
/** Sources whose `createdBy` is the creating employee's slug (or `session:<id>`). */
const EMPLOYEE_CREATED_SOURCES: ReadonlySet<string> = new Set(["session", "delegation"]);

/** The session a Todo's `sourceRef` names: `session:<id>:…` from a session's create,
 *  `delegate:<id>:…` from a session's delegation (`delegate:operator:…` names none). */
const CREATING_SESSION_REF = /^(?:session|delegate):([^:]+):/;

function creatingSessionId(item: WorkItem): string | undefined {
  const fromRef = item.sourceRef ? CREATING_SESSION_REF.exec(item.sourceRef)?.[1] : undefined;
  if (fromRef && fromRef !== HUMAN_CREATOR) return fromRef;
  return item.createdBy.startsWith(SESSION_ACTOR) ? item.createdBy.slice(SESSION_ACTOR.length) : undefined;
}

/**
 * Who created a Todo. A `created` row records only the source kind as its actor
 * (`human`, `session`, `delegation`, `cron`, …); the creator is on the Todo itself,
 * in `createdBy`, and the creating session in `sourceRef`. Reading the session from
 * there is what lets the loop guard see a Todo a hook session created.
 */
export function creatorOf(event: WorkItemEvent, item: WorkItem): HookActor {
  const sessionId = creatingSessionId(item);
  const base = { raw: event.actor, ...(sessionId ? { sessionId } : {}) };
  if (item.createdBy === HUMAN_CREATOR || item.source === "human") return { ...base, kind: "operator" };
  const employee = (sessionId ? getSession(sessionId)?.employee : undefined)
    ?? (EMPLOYEE_CREATED_SOURCES.has(item.source) && !item.createdBy.startsWith(SESSION_ACTOR) ? item.createdBy : undefined);
  return employee ? { ...base, kind: "employee", employee } : { ...base, kind: "system" };
}
