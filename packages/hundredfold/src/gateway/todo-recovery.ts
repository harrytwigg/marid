import { logger } from "../shared/logger.js";
import { loadConfig } from "../shared/config.js";
import { sweepTodoRecovery, todoRecoveryMode } from "../work-items/recovery-controller.js";
import { detectTodoAnomalies } from "../work-items/anomaly-detect.js";
import type { ApiContext } from "./api.js";
import { redispatchTodo } from "./todo-redispatch.js";

const DEFAULT_INTERVAL_MS = 5 * 60_000;

const RECOVERY_REASON = "This is a restart: the previous attempt stalled and Todo recovery is re-dispatching it.";

/**
 * Classify (and, if enabled, apply) bounded Todo recovery. Default mode is
 * classify-only so production observes lanes without auto-restarting until the
 * reviewed gate flips `gateway.todoRecovery.mode` to `auto`.
 */
export function startTodoRecovery(context: ApiContext, intervalMs = DEFAULT_INTERVAL_MS): () => void {
  const tick = (): void => {
    try {
      const mode = todoRecoveryMode(loadConfig().gateway.todoRecovery?.mode);
      if (mode === "off") return;
      const result = sweepTodoRecovery({
        mode,
        rearm: (todoId) => redispatchTodo(todoId, context, RECOVERY_REASON),
      });
      const anomalies = detectTodoAnomalies({ persist: true });
      if (result.classified > 0 || result.applied > 0 || anomalies.length > 0) {
        logger.info(
          `Todo recovery: classified ${result.classified}, applied ${result.applied}, anomalies ${anomalies.length} (mode ${mode})`,
        );
      }
    } catch (err) {
      logger.warn(`Todo recovery sweep failed: ${err instanceof Error ? err.message : err}`);
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
