/**
 * Reordering a parked queue, so one message runs next: a queued message
 * promoted with "send this one now".
 *
 * This decides the new order; the caller hands the rows' existing positions out
 * in it. `SessionQueue` claims the next row by position as each slot starts, so
 * a row's position is the only thing a reorder has to change.
 */

/** Target first, everyone else in the order they were already in. */
export function rotatePendingToFront<T extends { id: string }>(items: readonly T[], targetId: string): T[] {
  const index = items.findIndex((item) => item.id === targetId);
  if (index < 1) return [...items];
  return [items[index], ...items.slice(0, index), ...items.slice(index + 1)];
}
