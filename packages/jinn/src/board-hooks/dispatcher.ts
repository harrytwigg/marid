import type { ApiContext } from "../gateway/api.js";
import { runnableHooks, hookEvents, type BoardHookConfig, type BoardHookEvent } from "../shared/board-hooks-config.js";
import { initDb } from "../shared/db.js";
import { logger } from "../shared/logger.js";
import { setBoardEventListener } from "../work-items/board-event-tap.js";
import type { WorkItemEvent } from "../work-items/store.js";
import { stopHookCommands } from "./command-action.js";
import { boardEventName } from "./events.js";
import { fireHook, recordFailure } from "./fire.js";
import { eventChain } from "./loop-guard.js";
import { buildBasePayload } from "./payload.js";
import { interruptLeftoverRuns } from "./run-store.js";
import type { BasePayload } from "./types.js";

let installed: ApiContext | null = null;
const queue: WorkItemEvent[] = [];
let drainScheduled = false;

/** The enabled, runnable hooks that subscribe to `name`, read from the live config. */
function hooksFor(context: ApiContext, name: BoardHookEvent): BoardHookConfig[] {
  return runnableHooks(context.getConfig())
    .map(({ hook }) => hook)
    .filter((hook) => hook.enabled !== false && hookEvents(hook).includes(name));
}

/** A write inside a transaction that later rolled back left no row: it fires nothing. */
function rowExists(eventId: string): boolean {
  return initDb().prepare("SELECT 1 FROM work_item_events WHERE id = ?").get(eventId) !== undefined;
}

interface Evaluated {
  base: BasePayload;
  /** The hooks upstream of the event. */
  chain: string[];
}

/** The shared payload and loop-guard chain for an event, or null when its Todo is gone. */
function evaluate(event: WorkItemEvent, name: BoardHookEvent): Evaluated | null {
  const base = buildBasePayload(event, name);
  return base ? { base, chain: eventChain(base.actor.sessionId) } : null;
}

function processEvent(context: ApiContext, event: WorkItemEvent): void {
  const name = boardEventName(event);
  if (!name || !rowExists(event.id)) return;
  const hooks = hooksFor(context, name);
  if (hooks.length === 0) return;
  let evaluated: Evaluated | null;
  try {
    evaluated = evaluate(event, name);
  } catch (error) {
    for (const hook of hooks) recordFailure(context, { hook: hook.name, event: name, eventId: event.id, todoId: event.workItemId }, error);
    return;
  }
  if (!evaluated) return;
  for (const hook of hooks) {
    try {
      fireHook(context, hook, evaluated.base, evaluated.chain);
    } catch (error) {
      logger.warn(`board hook ${hook.name} failed on ${event.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function drain(): void {
  drainScheduled = false;
  const context = installed;
  const batch = queue.splice(0);
  if (!context) return;
  for (const event of batch) {
    try {
      processEvent(context, event);
    } catch (error) {
      logger.warn(`board hooks could not process ${event.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** The tap's listener: take the event off the write path and handle it on the next turn of the loop. */
function enqueue(event: WorkItemEvent): void {
  if (!installed || boardEventName(event) === null) return;
  queue.push(event);
  if (drainScheduled) return;
  drainScheduled = true;
  setImmediate(drain);
}

/** Start reacting to board events. Also the boot step that marks a previous process's running rows interrupted. */
export function installBoardHooks(context: ApiContext): void {
  installed = context;
  const swept = interruptLeftoverRuns();
  if (swept > 0) logger.info(`board hooks: marked ${swept} run(s) left over from the previous process as interrupted`);
  setBoardEventListener(enqueue);
}

/** Stop reacting, drop what has not been handled, and end commands still running. */
export function stopBoardHooks(): void {
  setBoardEventListener(null);
  installed = null;
  queue.length = 0;
  stopHookCommands();
}
