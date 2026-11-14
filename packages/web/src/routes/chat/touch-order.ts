/**
 * The chats the operator has opened, most recent first.
 *
 * Separate from the working set's `focusHistory`, which only ever holds panes
 * the working set already contains. The mobile strip has to rank chats that
 * were never panes at all, so this log spans every chat that has been committed
 * into view — a chip tap, a list row, a deep link, back and forward. Gateway
 * activity is deliberately not a touch: a chat an agent is streaming into is
 * not one the operator asked for.
 */

interface PersistedTouchOrder {
  version: 1
  sessionIds: string[]
}

export const TOUCH_ORDER_STORAGE_KEY = 'hundredfold-chat-touch-order'

/** Deep enough that pruning closed sessions still leaves candidates for the
 *  four mobile slots, shallow enough to stay a cheap write on every open. */
export const TOUCH_ORDER_LIMIT = 20

type TouchOrderStorage = Pick<Storage, 'getItem' | 'setItem'>

function uniqueIds(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<string>()
  const ids: string[] = []
  for (const value of input) {
    if (typeof value !== 'string') continue
    const id = value.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

/** Move a chat to the head. Returns the same log when it is already there, so
 *  re-rendering the open chat cannot loop the effect that persists it. */
export function recordTouchedSession(order: string[], rawSessionId: string): string[] {
  const sessionId = rawSessionId.trim()
  if (!sessionId || order[0] === sessionId) return order
  return [sessionId, ...order.filter((id) => id !== sessionId)].slice(0, TOUCH_ORDER_LIMIT)
}

export function pruneTouchOrder(
  order: readonly string[],
  liveSessionIds: ReadonlySet<string>,
): string[] {
  return order.filter((id) => liveSessionIds.has(id))
}

export function serializeTouchOrder(order: readonly string[]): string {
  const persisted: PersistedTouchOrder = {
    version: 1,
    sessionIds: uniqueIds(order).slice(0, TOUCH_ORDER_LIMIT),
  }
  return JSON.stringify(persisted)
}

export function restoreTouchOrder(
  raw: string | null,
  liveSessionIds: ReadonlySet<string>,
): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedTouchOrder>
    if (parsed.version !== 1) return []
    return pruneTouchOrder(uniqueIds(parsed.sessionIds), liveSessionIds).slice(0, TOUCH_ORDER_LIMIT)
  } catch {
    return []
  }
}

export function persistTouchOrder(storage: TouchOrderStorage, order: readonly string[]): void {
  try {
    storage.setItem(TOUCH_ORDER_STORAGE_KEY, serializeTouchOrder(order))
  } catch {
    // Private browsing and quota failures must not make chat navigation fail.
  }
}

export function loadPersistedTouchOrder(
  storage: TouchOrderStorage,
  liveSessionIds: ReadonlySet<string>,
): string[] {
  try {
    return restoreTouchOrder(storage.getItem(TOUCH_ORDER_STORAGE_KEY), liveSessionIds)
  } catch {
    return []
  }
}
