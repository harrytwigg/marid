import { startChildSettleWake } from "../work-items/child-settle-wake.js";
import type { ApiContext } from "./api.js";
import { orgRegistry } from "./org-registry.js";
import { redispatchTodo } from "./todo-redispatch.js";

/** Wake a parent Todo's owner when a child settles. Started once the gateway
 *  accepts requests: the startup pass delivers through its own message route. */
export function startTodoTreeWake(context: ApiContext): () => void {
  return startChildSettleWake({
    isEmployee: (name) => orgRegistry(context.getConfig()).has(name),
    redispatch: (todoId, reason) => redispatchTodo(todoId, context, reason),
  });
}
