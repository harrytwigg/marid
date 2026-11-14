import type { BoardHookConfig, BoardHookMatch } from "../shared/board-hooks-config.js";
import { OPERATOR_ASSIGNEE } from "../work-items/operator-assignee.js";
import type { BasePayload } from "./types.js";

function listOf(value: string | string[] | undefined): string[] | null {
  if (value === undefined) return null;
  return Array.isArray(value) ? value : [value];
}

/** `assignee: operator` means the operator's assignee value; the literal `@operator` is accepted too. */
function assigneeNames(wanted: string[]): string[] {
  return wanted.map((name) => (name === "operator" ? OPERATOR_ASSIGNEE : name));
}

function actorNames(payload: BasePayload): string[] {
  return [payload.actor.kind, ...(payload.actor.employee ? [payload.actor.employee] : [])];
}

function anyOf(wanted: string[] | null, have: readonly (string | null)[]): boolean {
  return wanted === null || have.some((value) => value !== null && wanted.includes(value));
}

function fieldsMatch(match: BoardHookMatch, payload: BasePayload, labels: readonly string[]): boolean {
  const assignee = listOf(match.assignee);
  return anyOf(listOf(match.from), [payload.from])
    && anyOf(listOf(match.to), [payload.to])
    && anyOf(listOf(match.department), [payload.todo.department])
    && anyOf(listOf(match.label), labels)
    && anyOf(assignee && assigneeNames(assignee), [payload.todo.assignee])
    && anyOf(listOf(match.actor), actorNames(payload))
    && anyOf(listOf(match.reviewAddressee), [payload.todo.reviewAddressee.kind]);
}

/** Whether `hook`'s matcher fits: every field present must match (AND); a list inside one field is any-of. */
export function matchesHook(hook: Pick<BoardHookConfig, "match">, payload: BasePayload, labels: readonly string[]): boolean {
  return !hook.match || fieldsMatch(hook.match, payload, labels);
}
