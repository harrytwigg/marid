import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { GatewayEvent, GatewayEventListener } from '@hundredfold/gateway-events'
import { api } from '@/lib/api'
import {
  __clearLiveSessionSnapshotCacheForTests,
  prefetchLiveSessionSnapshot,
} from '@/hooks/use-live-session'
import { ThreadPeek, type CommsPeekData } from '../thread-peek'
import { cleanLikeGateway } from '../teammate-reply'

const { subscribe, emit, resetBus } = vi.hoisted(() => {
  const listeners = new Set<GatewayEventListener>()
  const subscribe = vi.fn((fn: GatewayEventListener) => {
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  })
  const emit = (event: string, payload: unknown) => {
    for (const listener of listeners) listener({ event, payload } as GatewayEvent)
  }
  const resetBus = () => {
    listeners.clear()
    subscribe.mockClear()
  }
  return { subscribe, emit, resetBus }
})

vi.mock('@/lib/api', () => ({
  api: { getSession: vi.fn() },
}))

vi.mock('@/hooks/use-gateway', () => ({
  useGateway: () => ({
    events: [],
    connected: true,
    connectionSeq: 0,
    skillsVersion: 0,
    subscribe,
  }),
}))

const getSession = vi.mocked(api.getSession)

const SESSION_ID = 'child-live'

function dispatchedAt(): number {
  return Date.now() - 5 * 60_000
}

function workingPeek(overrides: Partial<CommsPeekData> = {}): CommsPeekData {
  return {
    kind: 'delegation',
    employee: 'design-lead',
    displayName: 'Design Lead',
    sessionId: SESSION_ID,
    messageId: 'delegation-1',
    timestamp: dispatchedAt(),
    preview: 'Inspect the layout',
    ...overrides,
  }
}

function replyPeek(overrides: Partial<CommsPeekData> = {}): CommsPeekData {
  return {
    kind: 'reply',
    employee: 'design-lead',
    displayName: 'Design Lead',
    sessionId: SESSION_ID,
    messageId: 'reply-1',
    timestamp: dispatchedAt(),
    preview: 'Canvas direction is ready.',
    ...overrides,
  }
}

function renderPeek(peek: CommsPeekData | null) {
  const onClose = vi.fn()
  const onOpenFullChat = vi.fn()
  const view = render(
    <ThreadPeek
      peek={peek}
      onClose={onClose}
      onOpenFullChat={onOpenFullChat}
      renderContent={(text) => text}
    />,
  )
  return { ...view, onClose, onOpenFullChat }
}

beforeEach(() => {
  resetBus()
  getSession.mockReset()
  __clearLiveSessionSnapshotCacheForTests()
})

describe('thread peek working state', () => {
  it('shows a pulsing working state line with elapsed minutes, not a checkmark', async () => {
    getSession.mockResolvedValue({ id: SESSION_ID, status: 'running', messages: [] })
    renderPeek(workingPeek())

    await waitFor(() => {
      expect(document.querySelector('[data-state-line="working"]')).toBeTruthy()
    })
    expect(document.querySelector('[data-state-line="replied"]')).toBeNull()
    expect(screen.getByText(/Working · 5m/)).toBeTruthy()
    expect(document.querySelector('[data-state-line="working"]')?.innerHTML).toContain('hundredfold-pulse')
  })

  it('re-renders live tool and text activity without reopening', async () => {
    getSession.mockResolvedValue({ id: SESSION_ID, status: 'running', messages: [] })
    renderPeek(workingPeek())
    await waitFor(() => expect(subscribe).toHaveBeenCalled())
    expect(screen.getByText('Starting up')).toBeTruthy()

    act(() => {
      emit('session:delta', { sessionId: SESSION_ID, type: 'tool_use', toolName: 'Bash' })
    })
    expect(screen.getByText(/Using Bash/)).toBeTruthy()
    expect(screen.queryByText('Starting up')).toBeNull()

    act(() => {
      emit('session:delta', { sessionId: SESSION_ID, type: 'text', content: 'Found the layout file.' })
    })
    expect(screen.getByText(/Found the layout file/)).toBeTruthy()
    expect(screen.getByText(/Using Bash/)).toBeTruthy()
  })

  it('renders a settled reply as the full final message with the replied state line', async () => {
    const fullReply = [
      'Canvas direction is ready.',
      'Keep left-in/right-out port discipline so every edge reads in one direction, and let the inspector own validation instead of the node body.',
      'Spacing stays on the 8px grid at every zoom, and the minimap stays out until a graph passes forty nodes.',
    ].join('\n\n')
    const preview = cleanLikeGateway(fullReply)
    // The closing line survives only in the full reply, so falling back to the
    // preview cannot satisfy the assertion below.
    expect(preview).not.toContain('minimap stays out')

    getSession.mockResolvedValue({
      id: SESSION_ID,
      status: 'idle',
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: fullReply },
      ],
    })
    renderPeek(replyPeek({ preview }))

    await waitFor(() => {
      expect(screen.getByText(/minimap stays out until a graph passes forty nodes/)).toBeTruthy()
    })
    expect(document.querySelector('[data-state-line="replied"]')).toBeTruthy()
    expect(document.querySelector('[data-state-line="working"]')).toBeNull()
    expect(screen.getByText(/Replied ·/)).toBeTruthy()
  })

  it('says Starting up when a working session has produced nothing yet', async () => {
    getSession.mockResolvedValue({ id: SESSION_ID, status: 'waiting', messages: [] })
    renderPeek(workingPeek())
    await act(async () => { await Promise.resolve() })

    expect(screen.getByText('Starting up')).toBeTruthy()
    expect(document.querySelector('[data-state-line="working"]')).toBeTruthy()
  })

  it('stays read-only with the same footer, open-full-chat, Escape, and scrim close', async () => {
    getSession.mockResolvedValue({ id: SESSION_ID, status: 'running', messages: [] })
    const first = renderPeek(workingPeek())
    await act(async () => { await Promise.resolve() })

    expect(screen.getByText('Read-only')).toBeTruthy()
    expect(document.querySelector('[data-testid="thread-peek"] textarea')).toBeNull()
    expect(document.querySelector('[data-testid="thread-peek"] input')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Open full chat' }))
    expect(first.onOpenFullChat).toHaveBeenCalledWith(SESSION_ID)

    fireEvent.click(screen.getByLabelText('Close preview'))
    expect(first.onClose).toHaveBeenCalledTimes(1)
    first.unmount()

    const second = renderPeek(workingPeek())
    await act(async () => { await Promise.resolve() })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(second.onClose).toHaveBeenCalledTimes(1)
  })

  it('shows live text through a snapshot that was cached before the child started', async () => {
    // The child was warm and idle when its snapshot was written; it started
    // again with the peek closed, so nothing rewrote that cached `idle` status.
    getSession.mockResolvedValue({
      id: SESSION_ID,
      status: 'idle',
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: 'Earlier reply.' },
      ],
    })
    await prefetchLiveSessionSnapshot(SESSION_ID)

    renderPeek(workingPeek())
    await waitFor(() => expect(subscribe).toHaveBeenCalled())

    act(() => {
      emit('session:delta', { sessionId: SESSION_ID, type: 'text', content: 'Reading the layout file.' })
    })

    expect(screen.getByText(/Reading the layout file/)).toBeTruthy()
    expect(document.querySelector('[data-state-line="working"]')).toBeTruthy()
    expect(document.querySelector('[data-state-line="replied"]')).toBeNull()
  })

  it('says Starting up when the current turn has no output yet, ignoring the previous reply', async () => {
    getSession.mockResolvedValue({
      id: SESSION_ID,
      status: 'running',
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: 'Earlier reply.' },
        { role: 'user', content: 'one more thing' },
      ],
    })
    renderPeek(workingPeek())

    await waitFor(() => expect(screen.getByText('Starting up')).toBeTruthy())
    expect(screen.queryByText(/Earlier reply/)).toBeNull()
    expect(document.querySelector('[data-state-line="working"]')).toBeTruthy()
  })

  it('says Starting up on a follow-up whose own user row has not arrived yet', async () => {
    // The child settled, then a follow-up was dispatched and its card opened at
    // once. The new user boundary is still in flight, so the newest thing in the
    // history is the PREVIOUS turn's final reply.
    const settledAt = Date.now() - 30 * 60_000
    getSession.mockResolvedValue({
      id: SESSION_ID,
      status: 'running',
      messages: [
        { role: 'user', content: 'go', timestamp: settledAt },
        { role: 'assistant', content: 'Earlier final reply.', timestamp: settledAt + 1_000 },
      ],
    })
    renderPeek(workingPeek())

    await waitFor(() => expect(screen.getByText('Starting up')).toBeTruthy())
    expect(screen.queryByText(/Earlier final reply/)).toBeNull()

    act(() => {
      emit('session:delta', { sessionId: SESSION_ID, type: 'text', content: 'Picking it up now.' })
    })
    expect(screen.getByText(/Picking it up now/)).toBeTruthy()
    expect(screen.queryByText(/Earlier final reply/)).toBeNull()
  })

  it('does not open a live subscription while the peek is closed', () => {
    renderPeek(null)
    expect(subscribe).not.toHaveBeenCalled()
    expect(getSession).not.toHaveBeenCalled()
  })
})
