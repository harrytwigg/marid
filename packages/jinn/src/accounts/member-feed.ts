import { getWorkItem, type WorkItem } from "../work-items/store.js";
import { boardOfTodo } from "../work-items/board-of.js";
import { memberWorkItem } from "./member-serialise.js";

/**
 * What a board member's socket is told about a gateway event, or nothing.
 *
 * Only Todo-shaped change events pass: `company:changed` with `entity: "todo"`, which is what Todo writes,
 * comment and attachment changes and status moves all announce. Every other event (sessions, deltas, the
 * org, config, Talk, sprints, departments) is dropped. A passing event is rebuilt as `{ entity, action, id }`
 * plus the Todo's version and, when the original carried a value, the member-safe Todo; the original's
 * `value` (a full Todo with a session-bearing `sourceRef`), `sessionId` and anything else are never forwarded.
 *
 * It passes when the Todo's root department, before or after the write, is one of the member's boards. When
 * it was on a held board before and is not after (moved off it), the member gets `removed` so the card goes.
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
    before: departmentLeft(record.fromDepartment), item, after: item ? boardOfTodo(item) : null,
  };
}

/** The department an event says the Todo's board was before the write, when it says one (a string, or null for the company board). */
function departmentLeft(value: unknown): string | null | undefined {
  return value === null || typeof value === "string" ? value : undefined;
}

/** The frame for a change, for a member who holds these boards; undefined when it is not on one of them (before or after). */
export function memberFrameFor(change: TodoChange, boards: ReadonlySet<string>): MemberFrame | undefined {
  const onAfter = change.after !== null && boards.has(change.after);
  const onBefore = typeof change.before === "string" && boards.has(change.before);
  if (!onAfter && !onBefore) return undefined;
  if (!onAfter || !change.item) return { event: "company:changed", payload: { entity: "todo", action: "removed", id: change.id } };
  return {
    event: "company:changed",
    payload: {
      entity: "todo", action: change.action, id: change.id, version: change.item.version,
      ...(change.hadValue ? { value: memberWorkItem(change.item) } : {}),
    },
  };
}

export function buildMemberFrame(event: string, payload: unknown, boards: ReadonlySet<string>): MemberFrame | undefined {
  const change = readTodoChange(event, payload);
  return change ? memberFrameFor(change, boards) : undefined;
}
