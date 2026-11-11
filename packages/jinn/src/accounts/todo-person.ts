import type { Database as DatabaseType } from "better-sqlite3";
import { OPERATOR_ASSIGNEE } from "../work-items/operator-assignee.js";
import { boardOfTodo } from "../work-items/board-of.js";
import { isMemberIdentity, memberIdOf } from "../work-items/member-identity.js";
import { planOwnership } from "../work-items/person-write.js";
import type { WorkItem } from "../work-items/store.js";
import { storedTodoPerson } from "../work-items/todo-people.js";
import { getGrant } from "./board-members.js";
import { getUserById } from "./users.js";

/**
 * Who may be named as the person responsible for a Todo: the operator, or an active user with access to the Todo's root
 * board (a grant of any role there) or an instance owner. Anyone else is refused, and so is a value that names no one.
 * Returns the reason, or undefined when the choice is allowed. Read inside the write's transaction, so a grant removed a
 * moment ago does not slip through.
 */
export function personChoiceProblem(db: DatabaseType, item: Pick<WorkItem, "id" | "rootId" | "department">, person: string): string | undefined {
  if (person === OPERATOR_ASSIGNEE) return undefined;
  if (!isMemberIdentity(person)) return "person must be @operator, a board member (user:<id>) or null";
  const user = getUserById(db, memberIdOf(person)!);
  if (!user || user.status !== "active") return "That person is not available";
  if (user.instanceRole === "owner") return undefined;
  const board = boardOfTodo(item);
  return board && getGrant(db, user.id, board) ? undefined : "That person does not have access to this board";
}

/**
 * Why the operator's Todo edit may not move the person as asked (a 422 body), or undefined. The person is judged against
 * the board the Todo will be on: a root that the same edit moves takes its person's access with it. A patch whose
 * `assignee` and `humanAssignee` contradict each other (naming that person moves the agent slot) is refused rather than
 * silently rewritten.
 */
export function ownershipEditProblem(
  db: DatabaseType,
  item: Pick<WorkItem, "id" | "rootId" | "department" | "assignee">,
  patch: { assignee?: string | null; humanAssignee?: string | null; department?: string | null },
): { error: string; code: string } | undefined {
  if (typeof patch.humanAssignee === "string") {
    const landing = item.rootId === item.id && patch.department !== undefined ? { ...item, department: patch.department } : item;
    const problem = personChoiceProblem(db, landing, patch.humanAssignee);
    if (problem) return { error: problem, code: "todo_invalid_person" };
  }
  if (patch.assignee !== undefined && patch.humanAssignee !== undefined
    && planOwnership(item, storedTodoPerson(db, item.id), patch).assignee !== patch.assignee) {
    return { error: "assignee and humanAssignee contradict each other: naming that person moves the agent slot", code: "todo_invalid_ownership" };
  }
  return undefined;
}
