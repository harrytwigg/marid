import type { JsonObject } from "../shared/types.js";
import type { WorkItem, WorkItemEvent, WorkItemStatus } from "./store.js";

/**
 * Live change signal for Todo writes that happen IN-PROCESS, outside
 * the HTTP routes: the cron mint, and every guarded status write,
 * whoever commits it. This module gives the gateway one registration point so
 * those lanes reach the web dashboard too. The non-status route lanes still emit
 * their own richer `company:changed` events at the persistence boundary. Null
 * (the default, and the state in tests/CLI runs without a server) makes every
 * notify a no-op.
 */

export interface TodoLiveEvent {
  entity: "todo";
  action: string;
  id: string;
  version: number;
  value?: JsonObject;
  /** The session that invoked the write, when one did. The client refetches its
   *  transcript as loss recovery for a dropped activity block. */
  sessionId?: string;
}

/**
 * A signal is HELD while the write that raised it is still inside an
 * enclosing transaction, and released only once that transaction commits.
 *
 * A cascade closes its descendants through nested `transition` calls, and a
 * nested call returns when its SAVEPOINT is released, not when the tree lands.
 * Announcing there reports a completion a rollback can still take back, and a
 * workflow trigger that has already fired cannot be unfired. Writes with no
 * enclosing transaction (the cron mint) still emit the moment they commit.
 */
let openTransactions = 0;
const heldSignals: Array<() => void> = [];

/** Run `commit` — a `db.transaction(…)` handle — releasing the signals raised
 *  under it only if it returns. A throw rolls the transaction back, so the
 *  signals are dropped with the writes that raised them. */
export function holdLiveSignalsUntilCommit<T>(commit: () => T): T {
  openTransactions += 1;
  let committed = false;
  try {
    const value = commit();
    committed = true;
    return value;
  } finally {
    openTransactions -= 1;
    if (openTransactions === 0) releaseHeldSignals(committed);
  }
}

/** The outermost transaction has ended: send everything it raised, or drop the
 *  lot when it rolled back. */
function releaseHeldSignals(committed: boolean): void {
  const pending = heldSignals.splice(0);
  if (!committed) return;
  for (const signal of pending) signal();
}

function emitOrHold(signal: () => void): void {
  if (openTransactions === 0) signal();
  else heldSignals.push(signal);
}

type TodoLiveEmitter = (event: TodoLiveEvent) => void;

let emitter: TodoLiveEmitter | null = null;

export function setTodoLiveEmitter(next: TodoLiveEmitter | null): void {
  emitter = next;
}

export function notifyTodoChanged(item: WorkItem, action: string, sessionId?: string): void {
  emitOrHold(() => {
    if (!emitter) return;
    try {
      emitter({
        entity: "todo",
        action,
        id: item.id,
        version: item.version,
        value: item as unknown as JsonObject,
        ...(sessionId ? { sessionId } : {}),
      });
    } catch {
      // A broken listener must never fail the write it observes.
    }
  });
}

/** The second listener on the same write: a committed status change, handed to
 *  the Workflow `todo-status` trigger bridge. Same null-default, same
 *  never-throw contract as the live emitter above. */
export interface TodoStatusChangeEvent extends WorkItemEvent {
  fromStatus: WorkItemStatus;
  toStatus: WorkItemStatus;
  item: WorkItem;
}

export type TodoStatusChangeListener = (event: TodoStatusChangeEvent) => void | Promise<void>;

/** A Todo's labels changed. The `todo-status` trigger's label filter reads the
 *  Todo when its event DRAINS rather than when the Todo moved, so a label that
 *  lands after the move has to re-open that drain — nothing else looks again. */
export type TodoLabelsChangeListener = (workItemId: string) => void | Promise<void>;

let todoStatusChangeListener: TodoStatusChangeListener | null = null;
const extraStatusChangeListeners = new Set<TodoStatusChangeListener>();
let todoLabelsChangeListener: TodoLabelsChangeListener | null = null;

export function setTodoStatusChangeListener(listener: TodoStatusChangeListener | null): void {
  todoStatusChangeListener = listener;
}

/** Another listener on the same committed status write, beside the single slot
 *  above. Returns the function that removes it. Each listener is isolated: one
 *  that throws or rejects never stops the others or the write. */
export function addTodoStatusChangeListener(listener: TodoStatusChangeListener): () => void {
  extraStatusChangeListeners.add(listener);
  return () => {
    extraStatusChangeListeners.delete(listener);
  };
}

export function setTodoLabelsChangeListener(listener: TodoLabelsChangeListener | null): void {
  todoLabelsChangeListener = listener;
}

/** Hand a committed write to one bridge listener, whatever it does — throw or
 *  reject — never rolling back or throwing from the write that already committed. */
function callListener<T>(listener: ((value: T) => void | Promise<void>) | null, value: T): void {
  if (!listener) return;
  try {
    const maybe = listener(value);
    if (maybe && typeof (maybe as Promise<void>).catch === "function") {
      void (maybe as Promise<void>).catch(() => undefined);
    }
  } catch {
    // Best-effort bridge: a workflow-fire failure must never roll back or throw
    // from the guarded lifecycle write that already committed.
  }
}

/** Hand a committed write to the bridge listeners. They are read when the
 *  signal releases, not when it was raised. */
function bridge<T>(current: () => Iterable<((value: T) => void | Promise<void>) | null>, value: T): void {
  emitOrHold(() => {
    for (const listener of [...current()]) callListener(listener, value);
  });
}

export function notifyTodoStatusChange(event: WorkItemEvent | undefined, item: WorkItem): void {
  if (!event || !event.fromStatus || !event.toStatus) return;
  bridge(() => [todoStatusChangeListener, ...extraStatusChangeListeners],
    { ...event, fromStatus: event.fromStatus, toStatus: event.toStatus, item });
}

export function notifyTodoLabelsChanged(workItemId: string): void {
  bridge(() => [todoLabelsChangeListener], workItemId);
}
