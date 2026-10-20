import { loadConfig } from "../shared/config.js";
import { QUIET_AFTER_MS, QUIET_BACKGROUND_TASK_MS, startQuietWatch, type QuietWindows } from "../work-items/quiet-watch.js";
import type { ApiContext } from "./api.js";
import { orgRegistry } from "./org-registry.js";
import { isSystemEmployeeName } from "./system-employees.js";
import { redispatchTodo } from "./todo-redispatch.js";

type QuietWatchConfig = { enabled?: boolean; afterMinutes?: number; backgroundTaskMinutes?: number } | undefined;

function minutes(value: number | undefined, fallbackMs: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value * 60_000 : fallbackMs;
}

/** The windows `gateway.todoQuietWatch` sets, or null when it turns the watch off. Read each sweep, so a config edit applies without a restart. */
export function quietWindows(config: QuietWatchConfig): QuietWindows | null {
  if (config?.enabled === false) return null;
  return {
    afterMs: minutes(config?.afterMinutes, QUIET_AFTER_MS),
    backgroundTaskMs: minutes(config?.backgroundTaskMinutes, QUIET_BACKGROUND_TASK_MS),
  };
}

/** Nudge quiet executing Todos and escalate the ones a nudge does not move. */
export function startTodoQuietWatch(context: ApiContext): () => void {
  return startQuietWatch({
    isEmployee: (name) => orgRegistry(context.getConfig()).has(name),
    isSystemEmployee: isSystemEmployeeName,
    redispatch: (todoId, reason) => redispatchTodo(todoId, context, reason),
    windows: () => quietWindows(loadConfig().gateway.todoQuietWatch),
  });
}
