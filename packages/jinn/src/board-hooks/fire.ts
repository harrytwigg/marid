import { randomUUID } from "node:crypto";
import type { ApiContext } from "../gateway/api.js";
import type { BoardHookConfig } from "../shared/board-hooks-config.js";
import { logger } from "../shared/logger.js";
import { redactText } from "../shared/redact.js";
import { runCommandAction, runNotifyAction, runSpawnAction } from "./actions.js";
import { suppressionReason } from "./loop-guard.js";
import { matchesHook } from "./matcher.js";
import { finishRun, insertRun } from "./run-store.js";
import type { ActionOutcome, BasePayload, HookPayload, HookRunAction } from "./types.js";

type ActionKind = Exclude<HookRunAction, "none">;
const ACTION_ORDER: readonly ActionKind[] = ["spawn", "command", "notify"];

function emitRun(context: ApiContext, id: string, hook: string, status: string): void {
  try {
    context.emit("hooks:run", { id, hook, status });
  } catch (error) {
    logger.warn(`hooks:run emit failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function execute(context: ApiContext, hook: BoardHookConfig, kind: ActionKind, payload: HookPayload): Promise<ActionOutcome> {
  if (kind === "spawn") return runSpawnAction(context, hook.action.spawn!, payload);
  if (kind === "command") return runCommandAction(hook.action.command!, payload);
  return runNotifyAction(context, hook.action.notify!, payload);
}

function errorOutcome(error: unknown): ActionOutcome {
  return { status: "error", error: redactText(error instanceof Error ? error.message : String(error)) };
}

function settle(context: ApiContext, runId: string, hook: string, outcome: ActionOutcome): void {
  try {
    const status = finishRun(runId, outcome);
    if (status) emitRun(context, runId, hook, status);
  } catch (error) {
    logger.warn(`board hook ${hook}: could not record the outcome of ${runId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Start one action as its own run row and let it finish on its own; nothing waits on it. */
function launch(context: ApiContext, hook: BoardHookConfig, kind: ActionKind, payload: HookPayload): void {
  const runId = insertRun({
    fireId: payload.fireId, hook: hook.name, event: payload.event, eventId: payload.eventId,
    todoId: payload.todo.id, action: kind, status: "running", payload, chain: payload.chain,
  });
  emitRun(context, runId, hook.name, "running");
  let pending: Promise<ActionOutcome>;
  try {
    pending = execute(context, hook, kind, payload);
  } catch (error) {
    pending = Promise.resolve(errorOutcome(error));
  }
  void pending.catch(errorOutcome).then((outcome) => settle(context, runId, hook.name, outcome));
}

function recordSuppressed(context: ApiContext, payload: HookPayload, reason: string): void {
  const runId = insertRun({
    fireId: payload.fireId, hook: payload.hook, event: payload.event, eventId: payload.eventId,
    todoId: payload.todo.id, action: "none", status: "suppressed", payload, chain: payload.chain, error: reason,
  });
  emitRun(context, runId, payload.hook, "suppressed");
}

/**
 * One (event, hook) pair: match, guard against loops, then start each action.
 * `chain` is the hooks upstream of the event; a payload carries it extended with
 * the hook that is firing (a suppressed one carries it as it was).
 */
export function fireHook(context: ApiContext, hook: BoardHookConfig, base: BasePayload, chain: string[]): void {
  if (!matchesHook(hook, base, base.todo.labels)) return;
  const fireId = `bhf_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const reason = suppressionReason(hook, chain);
  const payload: HookPayload = { ...base, fireId, hook: hook.name, chain: reason ? chain : [...chain, hook.name] };
  if (reason) {
    recordSuppressed(context, payload, reason);
    return;
  }
  for (const kind of ACTION_ORDER) if (hook.action[kind]) launch(context, hook, kind, payload);
}

/** Record that a hook could not even be evaluated (payload building failed), so "it did not fire" has an explanation. */
export function recordFailure(
  context: ApiContext,
  at: { hook: string; event: string; eventId: string; todoId: string },
  error: unknown,
): void {
  const runId = insertRun({
    ...at, fireId: `bhf_${randomUUID().replace(/-/g, "").slice(0, 12)}`, action: "none", status: "error",
    payload: { event: at.event, eventId: at.eventId, todoId: at.todoId }, chain: [], error: errorOutcome(error).error,
  });
  emitRun(context, runId, at.hook, "error");
}
