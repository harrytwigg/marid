import type { AvailabilityRearmResult } from "../work-items/availability-resume.js";
import { getWorkItem, type WorkItemStatus } from "../work-items/store.js";
import { emitTodoProjectionEvent, type ApiContext } from "./api.js";
import { startTodoDispatcher } from "./todo-dispatch.js";

/** Only work that was mid-flight is restarted by a clock. `in_review` is the
 *  operator's desk and `blocked` waits on a person, so neither is re-dispatched. */
const REDISPATCHABLE: ReadonlySet<WorkItemStatus> = new Set<WorkItemStatus>(["assigned", "executing"]);

/**
 * Restart a stalled Todo through the Todo Dispatcher, the same start the board's
 * Dispatch button and the idle-capacity loop use. The Dispatcher's own claim and
 * live-attempt check keep this from starting a second run of work that is
 * already moving, so a sweep may call it as often as it likes.
 */
export function redispatchTodo(todoId: string, context: ApiContext, reason: string): AvailabilityRearmResult {
  const item = getWorkItem(todoId);
  if (!item) return { unavailable: "the Todo no longer exists" };
  if (!REDISPATCHABLE.has(item.status)) {
    return { unavailable: `it is \`${item.status}\`, which a sweep does not restart` };
  }
  const started = startTodoDispatcher(item, context, {
    promptSuffix: reason,
    emitProjectionEvent: (id, action) => emitTodoProjectionEvent(context, id, action),
  });
  if (!started.ok) return { unavailable: started.body.error };
  if (started.body.reused) return { unavailable: "a Dispatcher is already running for it" };
  return { status: item.status };
}
