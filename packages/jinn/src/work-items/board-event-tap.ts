import { logger } from '../shared/logger.js';
import type { WorkItemEvent } from './store.js';

/**
 * The board-hooks event tap: one optional listener told about every audit event
 * an `appendWorkItemEvent` call wrote.
 *
 * The call returns when its own transaction (or savepoint) does, which can still
 * be inside an enclosing transaction that rolls back, so the listener must treat
 * an event as a candidate and confirm its row exists before acting on it. Null
 * (the default; tests and the CLI never register one) makes the tap a no-op, and
 * a throwing listener never reaches the writer.
 */
export type BoardEventListener = (event: WorkItemEvent) => void;

let listener: BoardEventListener | null = null;

export function setBoardEventListener(next: BoardEventListener | null): void {
  listener = next;
}

export function tapBoardEvent(event: WorkItemEvent): void {
  if (!listener) return;
  try {
    listener(event);
  } catch (error) {
    logger.warn(`board event listener failed on ${event.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
