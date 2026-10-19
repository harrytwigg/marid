import { startAvailabilityResumeSweep } from "../work-items/availability-resume.js";
import type { ApiContext } from "./api.js";
import { redispatchTodo } from "./todo-redispatch.js";
import { startTodoRecovery } from "./todo-recovery.js";

const AVAILABILITY_RESUME_REASON = "This is a restart: the previous attempt stopped on a provider quota or outage window that has since reopened.";

/** Availability resume plus bounded Todo recovery, both
 *  restarting stalled work through the Todo Dispatcher. */
export function startTodoSweeps(context: ApiContext): () => void {
  const stopResumes = startAvailabilityResumeSweep({
    rearm: (todoId) => redispatchTodo(todoId, context, AVAILABILITY_RESUME_REASON),
  });
  const stopRecovery = startTodoRecovery(context);
  return () => {
    stopResumes();
    stopRecovery();
  };
}
