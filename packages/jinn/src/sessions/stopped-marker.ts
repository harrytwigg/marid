// Whether a session was stopped on purpose, kept as its own row rather than read
// back from the session's display fields: `lastError` is overwritten by recovery
// and other writers, and a copy of the session's transport meta is stale as soon
// as another path writes it. Any turn that starts afterwards clears it
// (`updateSession` setting `running` or `waiting`): the guards upstream let only
// a deliberate start get that far.
import { initDb } from "../shared/db.js";
import type { Session } from "../shared/types.js";

const KEY_PREFIX = "session-stopped:";

/** The `meta` key that holds `sessionId`'s stop, for the writers that delete sessions. */
export function stoppedMarkerKey(sessionId: string): string {
  return `${KEY_PREFIX}${sessionId}`;
}

/** Record that `sessionId` was stopped on purpose. */
export function markSessionStopped(sessionId: string): void {
  initDb().prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(stoppedMarkerKey(sessionId), new Date().toISOString());
}

/** Forget it: someone started the session on purpose, or it was deleted. */
export function clearSessionStopped(sessionId: string): void {
  initDb().prepare("DELETE FROM meta WHERE key = ?").run(stoppedMarkerKey(sessionId));
}

export function hasStoppedMark(sessionId: string): boolean {
  return initDb().prepare("SELECT 1 FROM meta WHERE key = ?").get(stoppedMarkerKey(sessionId)) !== undefined;
}

/**
 * Stopped on purpose and not started since: nothing but a deliberate start may
 * wake it. The mark alone decides, whatever the status: a session stopped while
 * idle keeps `idle`, and every turn start clears the mark, so a later restart
 * interruption cannot make a session that has run since look stopped.
 */
export function isStoppedByUser(session: Pick<Session, "id">): boolean {
  return hasStoppedMark(session.id);
}
