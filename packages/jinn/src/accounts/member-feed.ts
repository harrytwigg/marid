import { getWorkItem, type WorkItem } from "../work-items/store.js";
import { boardOfTodo } from "../work-items/board-of.js";
import { memberIdentity } from "../work-items/member-identity.js";
import { memberWorkItem, type Viewer } from "./member-serialise.js";

/**
 * What a board member's socket is told about a gateway event, or nothing.
 *
 * Only Todo-shaped change events pass: `company:changed` with `entity: "todo"`, which is what Todo writes,
 * comment and attachment changes and status moves all announce. Every other event (sessions, deltas, the
 * org, config, Talk, sprints, departments) is dropped. A passing event is rebuilt as `{ entity, action, id }`
 * plus the Todo's version and, when the original carried a value, the member-safe Todo; the original's
 * `value` (a full Todo with a session-bearing `sourceRef`), `sessionId` and anything else are never forwarded.
 *
 * It passes when the Todo's root department, before or after the write, is one of the member's boards, or the Todo is in an
 * open tree whose root the member created (it left their boards and they keep reading it). When it was on a held board
 * before and is not readable after (moved off it), the member gets `removed` so the card goes.
 */
export interface MemberFrame {
  event: "company:changed";
  payload: { entity: "todo"; action: string; id: string; version?: number; value?: unknown };
}

/** A Todo change as one broadcast event describes it, with the Todo read once for every socket that is offered it. */
export interface TodoChange {
  action: string;
  id: string;
  hadValue: boolean;
  before: string | null | undefined;
  /** For a reparent: the root the Todo was under before it. */
  fromRootId: string | undefined;
  /** For a status write: the Todo's own status before and after it, as the write recorded them. */
  statusMove: { fromStatus: string; toStatus: string } | undefined;
  item: WorkItem | undefined;
  after: string | null;
}

/** The Todo change an event carries, or undefined for any event a member never hears. */
export function readTodoChange(event: string, payload: unknown): TodoChange | undefined {
  if (event !== "company:changed" || !payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  if (record.entity !== "todo" || typeof record.action !== "string" || typeof record.id !== "string") return undefined;
  const item = getWorkItem(record.id);
  return {
    action: record.action, id: record.id, hadValue: record.value !== undefined && record.value !== null,
    before: departmentLeft(record.fromDepartment), fromRootId: typeof record.fromRootId === "string" ? record.fromRootId : undefined,
    statusMove: statusMoveOf(record),
    item, after: item ? boardOfTodo(item) : null,
  };
}

/** The status move a status write's event carries, when it carries both ends of it. */
function statusMoveOf(record: Record<string, unknown>): TodoChange["statusMove"] {
  const { fromStatus, toStatus } = record;
  return typeof fromStatus === "string" && typeof toStatus === "string" ? { fromStatus, toStatus } : undefined;
}

/** The department an event says the Todo's board was before the write, when it says one (a string, or null for the company board). */
function departmentLeft(value: unknown): string | null | undefined {
  return value === null || typeof value === "string" ? value : undefined;
}

/**
 * The frame for a change, for a member who holds these boards; undefined when it is nothing they may hear of.
 *
 * It passes when the Todo is on one of their boards now, or sits in an open tree whose root they created (it left their
 * boards but they keep reading it), sub-tasks included. A Todo that was on one of their boards and is not readable now gets
 * `removed`; so does a root they created on the one write that closes it, and a Todo they created on the one write that reparents it out from under a tree
 * they could read; either names only an id they made.
 */
export function memberFrameFor(change: TodoChange, boards: ReadonlySet<string>, viewer: Viewer): MemberFrame | undefined {
  const onAfter = change.after !== null && boards.has(change.after);
  const { item } = change;
  if (item && (onAfter || viewer.readsAsCreator(item.rootId))) return changeFrame(change, item, viewer);
  return mustRemove(change, boards, viewer) ? { event: "company:changed", payload: { entity: "todo", action: "removed", id: change.id } } : undefined;
}

function changeFrame(change: TodoChange, item: WorkItem, viewer: Viewer): MemberFrame {
  return {
    event: "company:changed",
    payload: {
      entity: "todo", action: change.action, id: change.id, version: item.version,
      ...(change.hadValue ? { value: memberWorkItem(item, viewer) } : {}),
    },
  };
}

/**
 * Whether a Todo the member can no longer read is one their card must be dropped for: it was on their board, or they created it
 * and could read it immediately before this write, which this write took away. Two writes do that: a status write whose own
 * move closed a root they read as its creator (its sub-tasks are refetched with it, as on a move), and a reparent out from
 * under a root that gave them creator access. A department change or an assignment never ends creator access, so it never
 * sends one; and once access has ended every later write on the Todo is silent. The id is one they made, so naming it tells
 * them nothing.
 */
function mustRemove(change: TodoChange, boards: ReadonlySet<string>, viewer: Viewer): boolean {
  if (typeof change.before === "string" && boards.has(change.before)) return true;
  const { item } = change;
  if (!item || item.createdBy !== memberIdentity(viewer.userId)) return false;
  if (change.action === "reparented") return change.fromRootId !== undefined && viewer.hadCreatorAccess(change.fromRootId, item.id);
  return viewer.closedAsCreatorRoot(item, change.statusMove);
}
