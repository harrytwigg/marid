import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useChatTabs } from '@/hooks/use-chat-tabs'

const apiMocks = vi.hoisted(() => ({ getSession: vi.fn() }))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, api: apiMocks }
})

import { useChatTabSync } from '../use-chat-tab-sync'

type Listed = Array<{ id: string; title?: string; status?: string }>

function renderSync(initial: Listed) {
  return renderHook(({ sessions }: { sessions: Listed }) => {
    const tabs = useChatTabs()
    useChatTabSync(tabs, sessions)
    return tabs
  }, { initialProps: { sessions: initial } })
}

beforeEach(() => localStorage.clear())
afterEach(() => { vi.clearAllMocks(); localStorage.clear() })

describe('useChatTabSync', () => {
  it('lets the session list win over a lookup once it carries the chat', async () => {
    apiMocks.getSession.mockResolvedValue({ id: 'n', title: 'Old title', status: 'running' })
    const { result, rerender } = renderSync([{ id: 'a', title: 'A', status: 'idle' }])
    await waitFor(() => expect(result.current.hydrated).toBe(true))

    // A chat created on this page has its tab before the list catches up, so it is looked up.
    act(() => result.current.openTab({ sessionId: 'n', label: 'Loading...', status: 'running', unread: false, pinned: true }))
    await waitFor(() => expect(result.current.activeTab).toMatchObject({ label: 'Old title', status: 'running' }))

    rerender({ sessions: [{ id: 'a', title: 'A', status: 'idle' }, { id: 'n', title: 'New title', status: 'idle' }] })
    await waitFor(() => expect(result.current.activeTab).toMatchObject({ label: 'New title', status: 'idle' }))
    // A later refetch does not bring the lookup's snapshot back.
    rerender({ sessions: [{ id: 'a', title: 'A2', status: 'idle' }, { id: 'n', title: 'New title', status: 'idle' }] })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
    expect(result.current.activeTab).toMatchObject({ label: 'New title', status: 'idle' })
  })
})
