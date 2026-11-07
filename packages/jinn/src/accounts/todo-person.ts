import type { Database as DatabaseType } from "better-sqlite3";
import { OPERATOR_ASSIGNEE } from "../work-items/operator-assignee.js";
import { boardOfTodo } from "../work-items/board-of.js";
import { isMemberIdentity, memberIdOf } from "../work-items/member-identity.js";
import type { WorkItem } from "../work-items/store.js";
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
