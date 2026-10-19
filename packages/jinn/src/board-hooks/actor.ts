import { getSession } from "../sessions/registry.js";
import type { WorkItemComment } from "../work-items/comments.js";
import type { WorkItemEvent } from "../work-items/store.js";
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
