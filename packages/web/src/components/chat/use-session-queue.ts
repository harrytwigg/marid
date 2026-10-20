import { createContext, useCallback, useEffect, useMemo, useState } from 'react'
import type { GatewayEventListener } from '@jinn/gateway-events'
import { api, type QueueItem } from '@/lib/api'

/* A session's parked messages, addressed the way the transcript addresses them.
 * The queue's own order is not the transcript's — send-now moves payloads
 * between rows without moving the bubbles — so a card carries its own position
 * rather than inferring one from where it sits in the thread. */

export interface QueuedMessage {
  item: QueueItem
  /** 1 for the message that runs next. */
  position: number
}

export interface SessionQueue {
  byMessageId: ReadonlyMap<string, QueuedMessage>
  /** Parked messages waiting for the running turn, in delivery order. */
  pendingCount: number
  /** Each verb REJECTS on failure. The card is the only caller and it reports. */
  cancel: (itemId: string) => Promise<void>
  edit: (itemId: string, prompt: string) => Promise<void>
  sendNow: (itemId: string) => Promise<void>
  /** Force-send everything parked, in queue order, interrupting the turn. */
  sendAllNow: () => Promise<void>
  /** Point an optimistic message id at the canonical one the server minted. */
  adopt: (localId: string, sent: unknown) => void
}

const EMPTY: SessionQueue = {
  byMessageId: new Map(),
  pendingCount: 0,
  cancel: async () => {},
  edit: async () => {},
  sendNow: async () => {},
  sendAllNow: async () => {},
  adopt: () => {},
}

/**
 * A queued bubble appended optimistically carries a client-side id, while the
 * queue row is keyed by the id the server minted. Until the transcript reloads
 * those are different strings, so the card would not appear on the message that
 * just got queued. The alias closes that window.
 */
function withAliases(
  index: ReadonlyMap<string, QueuedMessage>,
  aliases: ReadonlyMap<string, string>,
): ReadonlyMap<string, QueuedMessage> {
  if (aliases.size === 0) return index
  const merged = new Map(index)
  for (const [localId, canonicalId] of aliases) {
    const entry = index.get(canonicalId)
    if (entry) merged.set(localId, entry)
  }
  return merged
}

export const SessionQueueContext = createContext<SessionQueue>(EMPTY)

/** Parked rows, keyed by the bubble each one will run. Rows with no message
 *  link are real queue work with nothing to render against, so they are left out
 *  rather than guessed at. */
export function indexByMessage(items: readonly QueueItem[]): ReadonlyMap<string, QueuedMessage> {
  const parked = items.filter((item) => item.status === 'pending')
  return new Map(parked.flatMap((item, index): Array<[string, QueuedMessage]> =>
    item.messageId ? [[item.messageId, { item, position: index + 1 }]] : []))
}

/** Optimistic-to-canonical message ids, forgotten when the pane changes session. */
function useMessageIdAliases(sessionId: string | null) {
  const [aliases, setAliases] = useState<ReadonlyMap<string, string>>(new Map())
  useEffect(() => { setAliases(new Map()) }, [sessionId])

  const adopt = useCallback((localId: string, sent: unknown) => {
    const canonicalId = (sent as { messageId?: unknown } | null)?.messageId
    if (typeof canonicalId !== 'string' || canonicalId === localId) return
    setAliases((prev) => new Map(prev).set(localId, canonicalId))
  }, [])

  return { aliases, adopt }
}

export function useSessionQueue(
  sessionId: string | null,
  subscribe: (fn: GatewayEventListener) => () => void,
): SessionQueue {
  const [items, setItems] = useState<QueueItem[]>([])

  const refresh = useCallback(async () => {
    if (!sessionId) return setItems([])
    try {
      setItems(await api.getSessionQueue(sessionId))
    } catch {
      // Non-fatal: the cards keep showing what the last good read said, and the
      // next queue:updated re-reads. A failed poll must not blank the thread.
    }
  }, [sessionId])

  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => subscribe((frame) => {
    if (frame.event !== 'queue:updated') return
    if (frame.payload.sessionId !== sessionId) return
    void refresh()
  }), [subscribe, sessionId, refresh])

  /** Refresh either way, then let the failure through: a card that says nothing
   *  after a rejected action is indistinguishable from one that worked. */
  const act = useCallback(async (run: () => Promise<unknown>) => {
    try {
      await run()
    } finally {
      await refresh()
    }
  }, [refresh])

  const { aliases, adopt } = useMessageIdAliases(sessionId)

  const byMessageId = useMemo(() => withAliases(indexByMessage(items), aliases), [items, aliases])

  const pendingCount = useMemo(() => items.filter((item) => item.status === 'pending').length, [items])

  return useMemo<SessionQueue>(() => sessionId === null ? EMPTY : {
    byMessageId,
    pendingCount,
    cancel: (itemId) => act(() => api.cancelQueueItem(sessionId, itemId)),
    edit: (itemId, prompt) => act(() => api.editQueueItem(sessionId, itemId, prompt)),
    sendNow: (itemId) => act(() => api.sendQueueItemNow(sessionId, itemId)),
    sendAllNow: () => act(() => api.sendAllQueueItemsNow(sessionId)),
    adopt,
  }, [sessionId, byMessageId, pendingCount, act, adopt])
}
