import type { Database as DatabaseType } from "better-sqlite3";
import { hashToken, isoNow, newId, newRawToken } from "./ids.js";
import type { UserRecord } from "./users.js";

/** Idle sessions end after 30 days, and no session outlives 90. */
export const SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 90 * 24 * 60 * 60 * 1000;
/** `last_seen_at` is written at most once a minute per session. */
export const SESSION_TOUCH_THROTTLE_MS = 60 * 1000;

export interface UserSession {
  id: string;
  userId: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  userAgent: string | null;
  ip: string | null;
  revokedAt: string | null;
}

interface SessionRow {
  id: string; user_id: string; created_at: string; last_seen_at: string; expires_at: string;
  user_agent: string | null; ip: string | null; revoked_at: string | null;
}

const COLUMNS = "id, user_id, created_at, last_seen_at, expires_at, user_agent, ip, revoked_at";

const toSession = (row: SessionRow): UserSession => ({
  id: row.id, userId: row.user_id, createdAt: row.created_at, lastSeenAt: row.last_seen_at, expiresAt: row.expires_at,
  userAgent: row.user_agent, ip: row.ip, revokedAt: row.revoked_at,
});

type RevocationListener = () => void;
const revocationListeners = new Set<RevocationListener>();

/** Called after any session is revoked (and when a user is disabled), so live sockets can be re-checked at once. */
export function onUserSessionsRevoked(listener: RevocationListener): () => void {
  revocationListeners.add(listener);
  return () => { revocationListeners.delete(listener); };
}

export function notifyUserSessionsRevoked(): void {
  for (const listener of revocationListeners) {
    try { listener(); } catch { /* a listener must not undo the revocation */ }
  }
}

export function createUserSession(
  db: DatabaseType,
  input: { userId: string; userAgent?: string | null; ip?: string | null; now?: number },
): { token: string; session: UserSession } {
  const now = input.now ?? Date.now();
  const token = newRawToken();
  const id = newId("uss");
  db.prepare(`INSERT INTO user_sessions (id, user_id, token_hash, created_at, last_seen_at, expires_at, user_agent, ip)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, input.userId, hashToken(token, "session"), isoNow(now), isoNow(now), isoNow(now + SESSION_ABSOLUTE_MS),
    input.userAgent?.slice(0, 300) ?? null, input.ip ?? null,
  );
  return { token, session: getUserSession(db, id)! };
}

export function getUserSession(db: DatabaseType, id: string): UserSession | undefined {
  const row = db.prepare(`SELECT ${COLUMNS} FROM user_sessions WHERE id = ?`).get(id) as SessionRow | undefined;
  return row ? toSession(row) : undefined;
}

export interface ResolvedUserSession { user: UserRecord; session: UserSession }

interface JoinedRow extends SessionRow {
  u_email: string; u_display_name: string; u_password_hash: string | null; u_instance_role: "member" | "owner";
  u_status: "active" | "disabled"; u_created_at: string; u_created_by: string; u_updated_at: string;
  u_disabled_at: string | null; u_password_set_at: string | null;
}

function sessionLive(session: UserSession, now: number): boolean {
  return session.revokedAt === null
    && Date.parse(session.expiresAt) > now
    && Date.parse(session.lastSeenAt) + SESSION_IDLE_MS > now;
}

/**
 * The live session a raw cookie token names, with its user. Read from the database on every call (no cache),
 * so a disabled user, a revoked session or an expired one stops working on the next request.
 */
export function resolveUserSession(db: DatabaseType, rawToken: string, now = Date.now()): ResolvedUserSession | undefined {
  const row = db.prepare(`SELECT s.id, s.user_id, s.created_at, s.last_seen_at, s.expires_at, s.user_agent, s.ip, s.revoked_at,
      u.email AS u_email, u.display_name AS u_display_name, u.password_hash AS u_password_hash, u.instance_role AS u_instance_role,
      u.status AS u_status, u.created_at AS u_created_at, u.created_by AS u_created_by, u.updated_at AS u_updated_at,
      u.disabled_at AS u_disabled_at, u.password_set_at AS u_password_set_at
    FROM user_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(hashToken(rawToken, "session")) as JoinedRow | undefined;
  if (!row || row.u_status !== "active") return undefined;
  const session = toSession(row);
  if (!sessionLive(session, now)) return undefined;
  const user: UserRecord = {
    id: row.user_id, email: row.u_email, displayName: row.u_display_name, passwordHash: row.u_password_hash,
    instanceRole: row.u_instance_role, status: row.u_status, createdAt: row.u_created_at, createdBy: row.u_created_by,
    updatedAt: row.u_updated_at, disabledAt: row.u_disabled_at, passwordSetAt: row.u_password_set_at,
  };
  return { user, session };
}

/** Slide the idle window, writing at most once per throttle period. */
export function touchUserSession(db: DatabaseType, session: UserSession, now = Date.now()): void {
  if (now - Date.parse(session.lastSeenAt) < SESSION_TOUCH_THROTTLE_MS) return;
  try {
    db.prepare("UPDATE user_sessions SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL").run(isoNow(now), session.id);
  } catch { /* a last-seen refresh must never fail the request it rode in on */ }
}

/** Sessions that are still usable, newest first. */
export function listUserSessions(db: DatabaseType, userId: string, now = Date.now()): UserSession[] {
  return (db.prepare(`SELECT ${COLUMNS} FROM user_sessions WHERE user_id = ? AND revoked_at IS NULL ORDER BY last_seen_at DESC, id`)
    .all(userId) as SessionRow[]).map(toSession).filter((session) => sessionLive(session, now));
}

export function revokeUserSession(db: DatabaseType, sessionId: string, now = Date.now()): boolean {
  const changed = db.prepare("UPDATE user_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(isoNow(now), sessionId).changes > 0;
  if (changed) notifyUserSessionsRevoked();
  return changed;
}

export function revokeUserSessionsForUser(db: DatabaseType, userId: string, opts: { exceptSessionId?: string; now?: number } = {}): number {
  const changed = db.prepare("UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id IS NOT ?")
    .run(isoNow(opts.now ?? Date.now()), userId, opts.exceptSessionId ?? null).changes;
  if (changed > 0) notifyUserSessionsRevoked();
  return changed;
}

/** Drop rows that can never be used again, so the table does not grow without bound. */
export function pruneUserSessions(db: DatabaseType, now = Date.now()): number {
  return db.prepare("DELETE FROM user_sessions WHERE expires_at <= ? OR (revoked_at IS NOT NULL AND revoked_at <= ?) OR last_seen_at <= ?")
    .run(isoNow(now), isoNow(now - 24 * 60 * 60 * 1000), isoNow(now - SESSION_IDLE_MS)).changes;
}
