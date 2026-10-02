import { isClockRestartable, type AvailabilityRearmResult } from "../work-items/availability-resume.js";
import { getWorkItem } from "../work-items/store.js";
import { emitTodoProjectionEvent, type ApiContext } from "./api.js";
import { startTodoDispatcher } from "./todo-dispatch.js";

/**
 * Restart a stalled Todo through the Todo Dispatcher, the same start the board's
 * Dispatch button and the board walk use. The Dispatcher's own claim and
 * live-attempt check keep this from starting a second run of work that is
 * already moving, so a sweep may call it as often as it likes.
 */
export function redispatchTodo(todoId: string, context: ApiContext, reason: string): AvailabilityRearmResult {
  const item = getWorkItem(todoId);
  if (!item) return { unavailable: "the Todo no longer exists" };
  if (!isClockRestartable(item)) {
    const why = item.status === "blocked" ? "a declared block" : `\`${item.status}\``;
    return { unavailable: `it is ${why}, which a sweep does not restart` };
  }
  const started = startTodoDispatcher(item, context, {
    promptSuffix: reason,
    emitProjectionEvent: (id, action) => emitTodoProjectionEvent(context, id, action),
  });
  if (!started.ok) return { unavailable: started.body.error };
  if (started.body.reused) return { unavailable: "a Dispatcher is already running for it" };
  return { status: item.status };
}
