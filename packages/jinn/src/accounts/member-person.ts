import { json } from "../gateway/route-helpers.js";
import { initDb } from "../shared/db.js";
import { holdLiveSignalsUntilCommit } from "../work-items/live-events.js";
import { changeTodoPerson, personClearBlocked } from "../work-items/person-write.js";
import { appendWorkItemEvent, getWorkItem, releaseOnOwnerChange, type WorkItem } from "../work-items/store.js";
import { NotVisibleError, assertCollaborator, grantedTodo, requireBoardRole, todoAccess } from "./member-access.js";
import type { MemberRouteContext } from "./member-context.js";
import { readObject, refuseUnsupported } from "./member-input.js";
import { announce, actorOf, answerWriteError } from "./member-writes.js";
import { memberWorkItem, viewerOf } from "./member-serialise.js";
import { personChoiceProblem } from "./todo-person.js";

/** Thrown inside the write's transaction when the person named may not be chosen; rolls it back. */
class PersonRefusedError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = "PersonRefusedError";
  }
}

/** The person the body names (`@operator`, `user:<id>`), or null to clear; undefined once a 400 or 403 is written. */
async function readPerson(ctx: MemberRouteContext): Promise<{ next: string | null } | undefined> {
  const body = await readObject(ctx);
  if (!body || refuseUnsupported(ctx, body, new Set(["person"]))) return undefined;
  const { person } = body;
  if (person === null) return { next: null };
  if (typeof person === "string" && person.trim()) return { next: person.trim() };
  json(ctx.res, { error: "person must be a non-empty string or null" }, 400);
  return undefined;
}

/** The write, read again under the lock: the grant, the board and the agent slot may have moved since the request was routed. */
function writePerson(ctx: MemberRouteContext, id: string, next: string | null): { item: WorkItem; changed: boolean } {
  const db = initDb();
  const userId = ctx.principal.userId;
  return holdLiveSignalsUntilCommit(() => db.transaction((): { item: WorkItem; changed: boolean } => {
    const current = getWorkItem(id);
    const access = current ? todoAccess(db, userId, current) : undefined;
    if (!current || !access) throw new NotVisibleError();
    if (access.via !== "board") throw new PersonRefusedError("Board members can only change Todos on a board they hold", 403, "todo_not_member_editable");
    assertCollaborator(db, userId, access.board);
    if (personClearBlocked(current, next)) throw new PersonRefusedError("Only the operator can clear a Todo that is assigned to the operator", 403, "person_operator_only");
    const problem = next === null ? undefined : personChoiceProblem(db, current, next);
    if (problem) throw new PersonRefusedError(problem, 422, "todo_invalid_person");
    const changed = changeTodoPerson(db, current, next, { actor: actorOf(ctx), effect: "state", append: appendWorkItemEvent, releaseOnOwnerChange });
    return { item: getWorkItem(id)!, changed };
  }).immediate());
}

/**
 * `PUT /api/member/todos/:id/person { person: string | null }`: name (`@operator` or a `user:<id>` with access to the board)
 * or clear the person responsible for a Todo on a board the member collaborates on or owns, whoever made the Todo. It is a label
 * of responsibility and not steering, so it needs no member-only tree and writes only a `person_changed` event: it never
 * starts, wakes or notifies an agent and fires no board hook. A viewer is refused (403); a Todo outside their boards is a 404.
 */
export async function setPerson(ctx: MemberRouteContext): Promise<void> {
  const granted = grantedTodo(ctx, ctx.params.id);
  if (!granted || !requireBoardRole(ctx, granted, "collaborator")) return;
  const read = await readPerson(ctx);
  if (!read) return;
  try {
    const { item, changed } = writePerson(ctx, granted.item.id, read.next);
    if (changed) announce(ctx, item.id, "metadata-updated", true);
    json(ctx.res, { workItem: memberWorkItem(item, viewerOf(ctx)) });
  } catch (err) {
    if (err instanceof PersonRefusedError) return void json(ctx.res, { error: err.message, code: err.code }, err.status);
    if (!answerWriteError(ctx, err)) throw err;
  }
}
