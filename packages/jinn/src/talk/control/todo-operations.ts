/**
 * What Talk can do to a Todo, declared.
 *
 * Its own module because `manifest.ts` has no size budget and a hard cap, and
 * because the Todo lane is the one that grows: this is where the next verb goes.
 */
import { gateway, integer, params, string } from "./operation-builders.js";
import type { TalkControlOperation } from "./types.js";

/**
 * The statuses a spoken instruction may move a Todo to.
 *
 * `cancelled` is deliberately absent. It is the one move the ledger has no way
 * back from, and a mis-heard "cancel it" would close real work — the web
 * surface keeps it behind a deliberate click, so voice does not get it at all.
 * `todo-extended` records that as a standing gap rather than an oversight.
 */
export const TALK_TODO_STATUSES = [
  "backlog", "executing", "in_review", "done", "blocked",
] as const;

export const TODO_GATEWAY_OPERATIONS: readonly TalkControlOperation[] = [
  gateway("read_todo", "Read one Todo from the authoritative ledger. Always call this for an operator-requested Todo id, even when its prefix is unfamiliar; never infer that it is missing.",
    params({ id: string("The full Todo id.") }, ["id"]),
    "todos", { mutability: "read", verification: "todo-reread" }),
  gateway("talk_create_todo", "Create a Todo. It starts in To do (the `backlog` status) with nobody assigned. In the spoken confirmation, say the new full Todo id.", params({
    title: string("The Todo's title — one line, what the work is."),
    body: string("The detail, if the operator gave any."),
    parentId: string("The id of the Todo this belongs under, if it is a sub-task."),
  }, ["title"]), "todos", { mutability: "write", verification: "todo-create-reread" }),
  gateway("talk_edit_todo", "Edit a Todo title, body, or priority using its current version.", params({
    id: string("The full Todo id."),
    expectedVersion: integer("The Todo version currently shown."),
    title: string("A replacement title."),
    body: string("A replacement body."),
    priority: integer("Priority from 0 through 3."),
  }, ["id", "expectedVersion"]), "todos", { mutability: "write", verification: "todo-version-reread" }),
  gateway("talk_set_todo_status", "Move a Todo to another status. Cancelling is not available by voice.", params({
    id: string("The full Todo id."),
    status: string("The status to move it to. The board shows `backlog` as \"To do\".", TALK_TODO_STATUSES),
    note: string("Why, when the move is to blocked."),
  }, ["id", "status"]), "todos", { mutability: "write", verification: "todo-status-reread" }),
  gateway("talk_comment_todo", "Add one operator comment to a Todo.",
    params({ id: string("The full Todo id."), body: string("The comment body.") }, ["id", "body"]),
    "todos", { mutability: "write", verification: "comment-reread" }),
  gateway("talk_assign_todo", "Assign a Todo to a named employee.",
    params({ id: string("The full Todo id."), assignee: string("The employee slug.") }, ["id", "assignee"]),
    "todos", { mutability: "write", verification: "todo-assignment-reread" }),
];
