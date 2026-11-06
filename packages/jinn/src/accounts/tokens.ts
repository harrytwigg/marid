import type { Database as DatabaseType } from "better-sqlite3";
import { hashToken, isoNow, newId, newRawToken } from "./ids.js";
import type { BoardRole } from "./board-members.js";
import type { InstanceRole } from "./users.js";

/** How long a link lives. An owner invite makes a co-operator, so it lasts a day, not a week. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const OWNER_INVITE_TTL_MS = 24 * 60 * 60 * 1000;
export const RESET_TTL_MS = 24 * 60 * 60 * 1000;

export type TokenPurpose = "invite" | "reset";

export interface TokenRecord {
  id: string;
  purpose: TokenPurpose;
  email: string;
  userId: string | null;
  department: string | null;
  role: BoardRole | null;
  instanceRole: InstanceRole | null;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
}

interface TokenRow {
  id: string; purpose: TokenPurpose; email: string; user_id: string | null; department: string | null; role: BoardRole | null;
  instance_role: InstanceRole | null; created_by: string; created_at: string; expires_at: string; used_at: string | null; revoked_at: string | null;
}

const COLUMNS = "id, purpose, email, user_id, department, role, instance_role, created_by, created_at, expires_at, used_at, revoked_at";

const toRecord = (row: TokenRow): TokenRecord => ({
  id: row.id, purpose: row.purpose, email: row.email, userId: row.user_id, department: row.department, role: row.role,
  instanceRole: row.instance_role, createdBy: row.created_by, createdAt: row.created_at, expiresAt: row.expires_at,
  usedAt: row.used_at, revokedAt: row.revoked_at,
});

export type TokenState = "valid" | "used" | "revoked" | "expired";

export function tokenState(token: TokenRecord, now: number): TokenState {
  if (token.usedAt) return "used";
  if (token.revokedAt) return "revoked";
  return Date.parse(token.expiresAt) <= now ? "expired" : "valid";
}

export interface NewToken {
  purpose: TokenPurpose;
  email: string;
  userId?: string | null;
  department?: string | null;
  role?: BoardRole | null;
  instanceRole?: InstanceRole | null;
  createdBy: string;
  ttlMs: number;
  now?: number;
}

/** Insert a token and return the raw value, which is shown once and never stored. */
export function issueToken(db: DatabaseType, input: NewToken): { token: string; record: TokenRecord } {
  const now = input.now ?? Date.now();
  const raw = newRawToken();
  const id = newId("utk");
  db.prepare(`INSERT INTO user_tokens (id, token_hash, purpose, email, user_id, department, role, instance_role, created_by, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, hashToken(raw, "token"), input.purpose, input.email, input.userId ?? null, input.department ?? null, input.role ?? null,
    input.instanceRole ?? null, input.createdBy, isoNow(now), isoNow(now + input.ttlMs),
  );
  return { token: raw, record: getTokenById(db, id)! };
}

export function getTokenById(db: DatabaseType, id: string): TokenRecord | undefined {
  const row = db.prepare(`SELECT ${COLUMNS} FROM user_tokens WHERE id = ?`).get(id) as TokenRow | undefined;
  return row ? toRecord(row) : undefined;
}

/** The record for a raw token of this purpose, whatever its state. */
export function findToken(db: DatabaseType, raw: unknown, purpose: TokenPurpose): TokenRecord | undefined {
  if (typeof raw !== "string" || raw.length < 16 || raw.length > 256) return undefined;
  const row = db.prepare(`SELECT ${COLUMNS} FROM user_tokens WHERE token_hash = ? AND purpose = ?`)
    .get(hashToken(raw, "token"), purpose) as TokenRow | undefined;
  return row ? toRecord(row) : undefined;
}

/** Claim a still-valid token. False when it was used, revoked or expired in the meantime. */
export function markTokenUsed(db: DatabaseType, id: string, now = Date.now()): boolean {
  return db.prepare("UPDATE user_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?")
    .run(isoNow(now), id, isoNow(now)).changes > 0;
}

export function revokeToken(db: DatabaseType, id: string, now = Date.now()): boolean {
  return db.prepare("UPDATE user_tokens SET revoked_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL")
    .run(isoNow(now), id).changes > 0;
}

/** A new invite replaces the previous unused one for the same person and board (or the instance, when `department` is null). */
export function revokeOpenInvites(db: DatabaseType, email: string, department: string | null, now = Date.now()): number {
  return db.prepare(`UPDATE user_tokens SET revoked_at = ? WHERE purpose = 'invite' AND email = ? AND department IS ?
    AND used_at IS NULL AND revoked_at IS NULL`).run(isoNow(now), email, department).changes;
}

/** Revoke every unused reset link for a user, as a new one or a password change makes older ones moot. */
export function revokeOpenResets(db: DatabaseType, userId: string, now = Date.now()): number {
  return db.prepare("UPDATE user_tokens SET revoked_at = ? WHERE purpose = 'reset' AND user_id = ? AND used_at IS NULL AND revoked_at IS NULL")
    .run(isoNow(now), userId).changes;
}

/** Pending invites, newest first; for one board when `department` is a string, every board and the instance when undefined. */
export function listPendingInvites(db: DatabaseType, opts: { department?: string; now?: number } = {}): TokenRecord[] {
  const now = isoNow(opts.now ?? Date.now());
  const rows = opts.department === undefined
    ? db.prepare(`SELECT ${COLUMNS} FROM user_tokens WHERE purpose = 'invite' AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC, id`).all(now)
    : db.prepare(`SELECT ${COLUMNS} FROM user_tokens WHERE purpose = 'invite' AND department = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC, id`).all(opts.department, now);
  return (rows as TokenRow[]).map(toRecord);
}
