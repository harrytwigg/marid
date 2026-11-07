import type { Database as DatabaseType } from "better-sqlite3";
import { OPERATOR_ASSIGNEE } from "./operator-assignee.js";
import type { AppendWorkItemEventInput, WorkItem } from "./store.js";
import { clearTodoPerson, writeTodoPerson } from "./todo-people.js";

/** Who writes and how, with what the person write needs from the store (passed in because the store imports this module). */
export interface PersonWrite {
  actor: string;
  effect: "state" | "companion";
  append: (input: AppendWorkItemEventInput) => unknown;
  releaseOnOwnerChange: (db: DatabaseType, current: WorkItem, assignee: string | null | undefined) => string[];
}

/**
 * Set (`@operator` or `user:<id>`) or clear (null) the person responsible for a Todo, inside the caller's transaction.
 * Returns whether anything changed; a repeat writes nothing.
 *
 * It is a label of responsibility and never steers an agent: the only event is `person_changed`, which no board hook,
 * dispatcher or notifier reads. `effect: "state"` advances the Todo's version with the event (a write that has no row
 * update of its own); `"companion"` rides a row update that already did.
 *
 * Clearing the person of a Todo whose agent slot holds the operator clears that `assignee` too: the operator in the
 * person slot IS that assignment (see HUMAN_ASSIGNEE_COLUMN_SQL), so a bare row delete would leave them showing. That is
 * the operator's to do, so a route that is not the operator's asks `personClearBlocked` first and refuses before this runs.
 */
export function changeTodoPerson(db: DatabaseType, current: WorkItem, next: string | null, write: PersonWrite): boolean {
  const { actor, effect } = write;
  const from = current.humanAssignee ?? null;
  if (next === from) return false;
  const clearsAssignee = next === null && current.assignee === OPERATOR_ASSIGNEE;
  if (next === null) clearTodoPerson(db, current.id);
  else writeTodoPerson(db, current.id, next, actor, new Date().toISOString());
  let released: string[] = [];
  if (clearsAssignee) {
    db.prepare("UPDATE work_items SET assignee = NULL WHERE id = ?").run(current.id);
    released = write.releaseOnOwnerChange(db, current, null);
  }
  write.append({
    workItemId: current.id,
    kind: "person_changed",
    actor,
    detail: { from, to: next, ...(clearsAssignee ? { assigneeCleared: true } : {}), ...(released.length > 0 ? { releasedSessions: released } : {}) },
    versionEffect: effect,
  });
  return true;
}

/** Whether a clear would have to clear the operator's `assignee`, which only the operator may do. */
export function personClearBlocked(current: Pick<WorkItem, "assignee">, next: string | null): boolean {
  return next === null && current.assignee === OPERATOR_ASSIGNEE;
}
