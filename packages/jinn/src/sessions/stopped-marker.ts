// Whether a session was stopped on purpose, kept as its own row rather than read
// back from the session's display fields: `lastError` is overwritten by recovery
// and other writers, and a copy of the session's transport meta is stale as soon
// as another path writes it. A deliberate start clears it (the dispatch of a turn).
import { initDb } from "../shared/db.js";
import type { Session } from "../shared/types.js";

const KEY_PREFIX = "session-stopped:";

/** Record that `sessionId` was stopped on purpose. */
export function markSessionStopped(sessionId: string): void {
  initDb().prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(`${KEY_PREFIX}${sessionId}`, new Date().toISOString());
}

/** Forget it: someone started the session on purpose, or it was deleted. */
export function clearSessionStopped(sessionId: string): void {
  initDb().prepare("DELETE FROM meta WHERE key = ?").run(`${KEY_PREFIX}${sessionId}`);
}

export function hasStoppedMark(sessionId: string): boolean {
  return initDb().prepare("SELECT 1 FROM meta WHERE key = ?").get(`${KEY_PREFIX}${sessionId}`) !== undefined;
}

/** Stopped on purpose and not started since: nothing but a deliberate start may wake it. */
export function isStoppedByUser(session: Session): boolean {
  return session.status === "interrupted" && hasStoppedMark(session.id);
}
