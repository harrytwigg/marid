import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { QueueItem } from '@/lib/api'
import { useSessionQueue } from '@/components/chat/use-session-queue'

/* Round 2 — the two things the queue hook owns that the card cannot:
 * which transcript id a card is found under, and what happens when the server
 * says no. */

const { getSessionQueue, cancelQueueItem, sendAllQueueItemsNow } = vi.hoisted(() => ({
  getSessionQueue: vi.fn(),
  cancelQueueItem: vi.fn(),
  sendAllQueueItemsNow: vi.fn(),
}))
vi.mock('@/lib/api', () => ({ api: { getSessionQueue, cancelQueueItem, sendAllQueueItemsNow } }))

const parked: QueueItem = {
  id: 'qi_1',
  sessionId: 's1',
  prompt: 'draft the digest',
  status: 'pending',
  position: 1,
  createdAt: '2026-08-21T10:00:00.000Z',
  messageId: 'canonical-id',
}

const noEvents = () => () => {}

beforeEach(() => {
  getSessionQueue.mockReset().mockResolvedValue([parked])
  cancelQueueItem.mockReset().mockResolvedValue({ status: 'cancelled', messageId: 'canonical-id' })
  sendAllQueueItemsNow.mockReset().mockResolvedValue({ status: 'sent-now', count: 1 })
})

describe('useSessionQueue', () => {
  it('finds the card under the optimistic id once the send names the canonical one', async () => {
    const { result } = renderHook(() => useSessionQueue('s1', noEvents))
    await waitFor(() => expect(result.current.byMessageId.has('canonical-id')).toBe(true))
    // The bubble the pane appended optimistically is keyed by a client uuid, so
    // without the alias the freshly queued message renders as a plain bubble.
    expect(result.current.byMessageId.has('local-uuid')).toBe(false)

    act(() => result.current.adopt('local-uuid', { messageId: 'canonical-id' }))

    expect(result.current.byMessageId.get('local-uuid')?.item.id).toBe('qi_1')
    expect(result.current.byMessageId.get('local-uuid')?.position).toBe(1)
  })

  it('ignores a send that named no message', async () => {
    const { result } = renderHook(() => useSessionQueue('s1', noEvents))
    await waitFor(() => expect(result.current.byMessageId.size).toBe(1))

    act(() => result.current.adopt('local-uuid', { status: 'queued' }))

    expect(result.current.byMessageId.has('local-uuid')).toBe(false)
  })

  it('counts parked messages and force-sends them all', async () => {
    const { result } = renderHook(() => useSessionQueue('s1', noEvents))
    await waitFor(() => expect(result.current.pendingCount).toBe(1))

    await act(async () => { await result.current.sendAllNow() })

    expect(sendAllQueueItemsNow).toHaveBeenCalledWith('s1')
  })

  it('withdraws a cancelled message from the transcript, under its optimistic id too', async () => {
    const { result } = renderHook(() => useSessionQueue('s1', noEvents))
    await waitFor(() => expect(result.current.byMessageId.size).toBe(1))
    act(() => result.current.adopt('local-uuid', { messageId: 'canonical-id' }))
    getSessionQueue.mockResolvedValue([])

    await act(async () => { await result.current.cancel('qi_1') })

    expect(cancelQueueItem).toHaveBeenCalledWith('s1', 'qi_1')
    expect([...result.current.withdrawn].sort()).toEqual(['canonical-id', 'local-uuid'])
  })

  it('withdraws the message the server says it removed, not the one this view last saw on the row', async () => {
    // Send-now moves message ids between rows; the server's answer is the truth.
    cancelQueueItem.mockResolvedValue({ status: 'cancelled', messageId: 'moved-here-id' })
    const { result } = renderHook(() => useSessionQueue('s1', noEvents))
    await waitFor(() => expect(result.current.byMessageId.size).toBe(1))

    await act(async () => { await result.current.cancel('qi_1') })

    expect([...result.current.withdrawn]).toEqual(['moved-here-id'])
  })

  it('withdraws a message cancelled from another view', async () => {
    let listener: ((frame: unknown) => void) | undefined
    const subscribe = (fn: (frame: unknown) => void) => { listener = fn; return () => {} }
    const { result } = renderHook(() => useSessionQueue('s1', subscribe as never))
    await waitFor(() => expect(listener).toBeDefined())

    act(() => listener!({ event: 'queue:updated', payload: { sessionId: 's1', sessionKey: 'k', withdrawnMessageId: 'elsewhere-id' } }))

    expect([...result.current.withdrawn]).toEqual(['elsewhere-id'])
  })

  it('keeps a message whose cancel the server refused', async () => {
    cancelQueueItem.mockRejectedValue(new Error('Only a pending message can be cancelled'))
    const { result } = renderHook(() => useSessionQueue('s1', noEvents))
    await waitFor(() => expect(result.current.byMessageId.size).toBe(1))

    await act(async () => { await result.current.cancel('qi_1').catch(() => {}) })

    expect(result.current.withdrawn.size).toBe(0)
  })

  it('lets a rejected action reach its caller, having refreshed anyway', async () => {
    cancelQueueItem.mockRejectedValue(new Error('Item not found or already running'))
    const { result } = renderHook(() => useSessionQueue('s1', noEvents))
    await waitFor(() => expect(getSessionQueue).toHaveBeenCalledTimes(1))

    await expect(result.current.cancel('qi_1')).rejects.toThrow('Item not found or already running')
    expect(getSessionQueue).toHaveBeenCalledTimes(2)
  })
})
