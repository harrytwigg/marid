import type { Database as DatabaseType } from "better-sqlite3";
import { memberIdentity } from "../work-items/member-identity.js";
import { clearPeopleOfUser } from "../work-items/todo-people.js";
import { isoNow, newId } from "./ids.js";

export type InstanceRole = "member" | "owner";
export type UserStatus = "active" | "disabled";

export interface UserRecord {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string | null;
  instanceRole: InstanceRole;
  status: UserStatus;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  disabledAt: string | null;
  passwordSetAt: string | null;
}

/** What leaves the gateway: never the hash. */
export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  instanceRole: InstanceRole;
  status: UserStatus;
  hasPassword: boolean;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  disabledAt: string | null;
  passwordSetAt: string | null;
}

interface UserRow {
  id: string; email: string; display_name: string; password_hash: string | null; instance_role: InstanceRole;
  status: UserStatus; created_at: string; created_by: string; updated_at: string; disabled_at: string | null;
  password_set_at: string | null;
}

const COLUMNS = "id, email, display_name, password_hash, instance_role, status, created_at, created_by, updated_at, disabled_at, password_set_at";

function toRecord(row: UserRow): UserRecord {
  return {
    id: row.id, email: row.email, displayName: row.display_name, passwordHash: row.password_hash,
    instanceRole: row.instance_role, status: row.status, createdAt: row.created_at, createdBy: row.created_by,
    updatedAt: row.updated_at, disabledAt: row.disabled_at, passwordSetAt: row.password_set_at,
  };
}

export function publicUser(user: UserRecord): PublicUser {
  const { passwordHash, ...rest } = user;
  return { ...rest, hasPassword: passwordHash !== null };
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@.][^\s@]*\.[^\s@]+$/;

/** Trimmed and lower-cased, or null when it cannot be an address. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  return email.length <= 254 && EMAIL_PATTERN.test(email) ? email : null;
}

/** 1 to 80 characters once trimmed, no control characters. */
export function normalizeDisplayName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  const hasControl = [...name].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);
  return name.length >= 1 && name.length <= 80 && !hasControl ? name : null;
}

export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/.test(err.message);
}

export function getUserById(db: DatabaseType, id: string): UserRecord | undefined {
  const row = db.prepare(`SELECT ${COLUMNS} FROM users WHERE id = ?`).get(id) as UserRow | undefined;
  return row ? toRecord(row) : undefined;
}

export function getUserByEmail(db: DatabaseType, email: string): UserRecord | undefined {
  const row = db.prepare(`SELECT ${COLUMNS} FROM users WHERE email = ?`).get(email) as UserRow | undefined;
  return row ? toRecord(row) : undefined;
}

export function listUsers(db: DatabaseType): UserRecord[] {
  return (db.prepare(`SELECT ${COLUMNS} FROM users ORDER BY created_at, id`).all() as UserRow[]).map(toRecord);
}

export function countUsers(db: DatabaseType): number {
  return Number(db.prepare("SELECT COUNT(*) FROM users").pluck().get());
}

export interface NewUser {
  email: string;
  displayName: string;
  passwordHash: string | null;
  instanceRole?: InstanceRole;
  createdBy: string;
  now?: number;
}

/** Throws on a taken address (see `isUniqueViolation`). Callers pass an already-normalised email and name. */
export function createUser(db: DatabaseType, input: NewUser): UserRecord {
  const now = isoNow(input.now ?? Date.now());
  const id = newId("usr");
  db.prepare(`INSERT INTO users (id, email, display_name, password_hash, instance_role, status, created_at, created_by, updated_at, password_set_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`).run(
    id, input.email, input.displayName, input.passwordHash, input.instanceRole ?? "member", now, input.createdBy, now,
    input.passwordHash ? now : null,
  );
  return getUserById(db, id)!;
}

export interface UserPatch { displayName?: string; status?: UserStatus; instanceRole?: InstanceRole }

export function updateUser(db: DatabaseType, id: string, patch: UserPatch, now = Date.now()): UserRecord | undefined {
  const existing = getUserById(db, id);
  if (!existing) return undefined;
  const at = isoNow(now);
  const status = patch.status ?? existing.status;
  const disabledAt = status === "disabled" ? (existing.status === "disabled" ? existing.disabledAt : at) : null;
  db.prepare("UPDATE users SET display_name = ?, status = ?, instance_role = ?, disabled_at = ?, updated_at = ? WHERE id = ?")
    .run(patch.displayName ?? existing.displayName, status, patch.instanceRole ?? existing.instanceRole, disabledAt, at, id);
  return getUserById(db, id);
}

export function setUserPasswordHash(db: DatabaseType, id: string, passwordHash: string, now = Date.now()): void {
  const at = isoNow(now);
  db.prepare("UPDATE users SET password_hash = ?, password_set_at = ?, updated_at = ? WHERE id = ?").run(passwordHash, at, at, id);
}

/**
 * Removes the user and what hangs off them: grants and sessions (also by cascade), any token naming them, and their rows
 * as the person responsible, each Todo told with a `person_changed` event. `onPeopleCleared` hears which Todos those were.
 */
export function deleteUser(db: DatabaseType, id: string, onPeopleCleared?: (todoIds: string[]) => void): boolean {
  const { deleted, cleared } = db.transaction((): { deleted: boolean; cleared: string[] } => {
    db.prepare("DELETE FROM board_members WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM user_sessions WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM user_tokens WHERE user_id = ?").run(id);
    const cleared = clearPeopleOfUser(db, memberIdentity(id));
    const deleted = db.prepare("DELETE FROM users WHERE id = ?").run(id).changes > 0;
    return { deleted, cleared };
  })();
  if (cleared.length > 0) onPeopleCleared?.(cleared);
  return deleted;
}
