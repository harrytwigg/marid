/**
 * Reordering a parked queue, so one message runs next: a queued message
 * promoted with "send this one now", or a new message sent to interrupt.
 *
 * The rows themselves cannot move: `SessionQueue.enqueue` commits a promise
 * chain at enqueue time and that order is fixed. So the payloads move through
 * the rows instead — this decides the order they land in, and the caller writes
 * payload N onto row N.
 */

/** Target first, everyone else in the order they were already in. */
export function rotatePendingToFront<T extends { id: string }>(items: readonly T[], targetId: string): T[] {
  const index = items.findIndex((item) => item.id === targetId);
  if (index < 1) return [...items];
  return [items[index], ...items.slice(0, index), ...items.slice(index + 1)];
}
