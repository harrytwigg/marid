import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { QueueItem } from '@/lib/api'
import { useSessionQueue } from '@/components/chat/use-session-queue'

/* Round 2 — the two things the queue hook owns that the card cannot:
 * which transcript id a card is found under, and what happens when the server
 * says no. */

const { getSessionQueue, cancelQueueItem } = vi.hoisted(() => ({
  getSessionQueue: vi.fn(),
  cancelQueueItem: vi.fn(),
}))
vi.mock('@/lib/api', () => ({ api: { getSessionQueue, cancelQueueItem } }))

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
  cancelQueueItem.mockReset().mockResolvedValue({ status: 'cancelled' })
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

  it('lets a rejected action reach its caller, having refreshed anyway', async () => {
    cancelQueueItem.mockRejectedValue(new Error('Item not found or already running'))
    const { result } = renderHook(() => useSessionQueue('s1', noEvents))
    await waitFor(() => expect(getSessionQueue).toHaveBeenCalledTimes(1))

    await expect(result.current.cancel('qi_1')).rejects.toThrow('Item not found or already running')
    expect(getSessionQueue).toHaveBeenCalledTimes(2)
  })
})
