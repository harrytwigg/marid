import { getWorkItem } from "../work-items/store.js";
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

function todoChange(payload: unknown): { action: string; id: string; hadValue: boolean; before: string | null | undefined } | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  if (record.entity !== "todo" || typeof record.action !== "string" || typeof record.id !== "string") return undefined;
  const before = record.fromDepartment === null || typeof record.fromDepartment === "string" ? record.fromDepartment : undefined;
  return { action: record.action, id: record.id, hadValue: record.value !== undefined && record.value !== null, before };
}

export function buildMemberFrame(event: string, payload: unknown, boards: ReadonlySet<string>): MemberFrame | undefined {
  if (event !== "company:changed") return undefined;
  const change = todoChange(payload);
  if (!change) return undefined;
  const item = getWorkItem(change.id);
  const after = item ? boardOfTodo(item) : null;
  const onAfter = after !== null && boards.has(after);
  const onBefore = typeof change.before === "string" && boards.has(change.before);
  if (!onAfter && !onBefore) return undefined;
  if (!onAfter) return { event: "company:changed", payload: { entity: "todo", action: "removed", id: change.id } };
  return {
    event: "company:changed",
    payload: {
      entity: "todo", action: change.action, id: change.id, version: item!.version,
      ...(change.hadValue ? { value: memberWorkItem(item!) } : {}),
    },
  };
}
