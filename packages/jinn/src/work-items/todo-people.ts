import type { Database as DatabaseType } from "better-sqlite3";
import { OPERATOR_ASSIGNEE } from "./operator-assignee.js";

/** The person responsible for a Todo, beside the agent `assignee` names.
 *
 *  Held in `todo_people` (DDL in `accounts/schema.ts`, shape-verified at boot with the account tables), never a column
 *  on `work_items`: the exact-shape verifier refuses drift in an existing table, so an additive table is the only
 *  extension a deployed database survives, and an older build ignores it. A row exists only while a person is set.
 *
 *  A Todo with no row whose `assignee` is the operator reads as the operator's, so a Todo that already "needs the
 *  operator" shows them in the person slot with no row written. Every function takes the caller's `db` so it composes
 *  inside the caller's transaction, and this module never imports the store (the store imports it). */

/** The `human_assignee` select-list term every Todo read carries, so `humanAssignee` is on the row like `startAt`. */
export const HUMAN_ASSIGNEE_COLUMN_SQL =
  `COALESCE((SELECT tp.person FROM todo_people tp WHERE tp.todo_id = work_items.id), CASE WHEN work_items.assignee = '${OPERATOR_ASSIGNEE}' THEN '${OPERATOR_ASSIGNEE}' END) AS human_assignee`;

/** The row's own value, ignoring the legacy fallback: what a clear has to delete. */
export function storedTodoPerson(db: DatabaseType, todoId: string): string | null {
  return (db.prepare("SELECT person FROM todo_people WHERE todo_id = ?").pluck().get(todoId) as string | undefined) ?? null;
}

export function writeTodoPerson(db: DatabaseType, todoId: string, person: string, setBy: string, at: string): void {
  db.prepare(
    `INSERT INTO todo_people (todo_id, person, set_by, set_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(todo_id) DO UPDATE SET person = excluded.person, set_by = excluded.set_by, set_at = excluded.set_at`,
  ).run(todoId, person, setBy, at);
}

/** Drop a Todo's row. Whatever deletes a Todo calls this; no path deletes one today. */
export function clearTodoPerson(db: DatabaseType, todoId: string): boolean {
  return db.prepare("DELETE FROM todo_people WHERE todo_id = ?").run(todoId).changes > 0;
}

/** Drop every row naming a user, in the transaction that deletes the user. */
export function clearPeopleOfUser(db: DatabaseType, userIdentity: string): number {
  return db.prepare("DELETE FROM todo_people WHERE person = ?").run(userIdentity).changes;
}
