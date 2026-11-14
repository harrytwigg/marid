import type { Database as DatabaseType } from "better-sqlite3";
import { isoNow } from "./ids.js";

export type BoardRole = "viewer" | "collaborator" | "owner";
export const BOARD_ROLES: readonly BoardRole[] = ["viewer", "collaborator", "owner"];

export function isBoardRole(value: unknown): value is BoardRole {
  return typeof value === "string" && (BOARD_ROLES as readonly string[]).includes(value);
}

export interface BoardGrant {
  userId: string;
  department: string;
  role: BoardRole;
  grantedBy: string;
  grantedAt: string;
}

interface GrantRow { user_id: string; department: string; role: BoardRole; granted_by: string; granted_at: string }

const toGrant = (row: GrantRow): BoardGrant => ({
  userId: row.user_id, department: row.department, role: row.role, grantedBy: row.granted_by, grantedAt: row.granted_at,
});

export function listGrantsForUser(db: DatabaseType, userId: string): BoardGrant[] {
  return (db.prepare("SELECT user_id, department, role, granted_by, granted_at FROM board_members WHERE user_id = ? ORDER BY department")
    .all(userId) as GrantRow[]).map(toGrant);
}

export function listGrantsForBoard(db: DatabaseType, department: string): BoardGrant[] {
  return (db.prepare("SELECT user_id, department, role, granted_by, granted_at FROM board_members WHERE department = ? ORDER BY granted_at, user_id")
    .all(department) as GrantRow[]).map(toGrant);
}

export function getGrant(db: DatabaseType, userId: string, department: string): BoardGrant | undefined {
  const row = db.prepare("SELECT user_id, department, role, granted_by, granted_at FROM board_members WHERE user_id = ? AND department = ?")
    .get(userId, department) as GrantRow | undefined;
  return row ? toGrant(row) : undefined;
}

/** Add the grant, or change its role when the person is already on the board. */
export function upsertGrant(db: DatabaseType, grant: { userId: string; department: string; role: BoardRole; grantedBy: string; now?: number }): BoardGrant {
  db.prepare(`INSERT INTO board_members (user_id, department, role, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, department) DO UPDATE SET role = excluded.role, granted_by = excluded.granted_by, granted_at = excluded.granted_at`)
    .run(grant.userId, grant.department, grant.role, grant.grantedBy, isoNow(grant.now ?? Date.now()));
  return getGrant(db, grant.userId, grant.department)!;
}

export function removeGrant(db: DatabaseType, userId: string, department: string): boolean {
  return db.prepare("DELETE FROM board_members WHERE user_id = ? AND department = ?").run(userId, department).changes > 0;
}
