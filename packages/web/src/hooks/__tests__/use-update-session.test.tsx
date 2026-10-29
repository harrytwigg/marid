import { describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { queryKeys } from '@/lib/query-keys'
import type { SessionsResponse } from '@/lib/api'

const updateSession = vi.fn()
vi.mock('@/lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/api')>()), api: { ...(await importOriginal<typeof import('@/lib/api')>()).api, updateSession: (...args: unknown[]) => updateSession(...args) } }))

import { useUpdateSession } from '../use-sessions'

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const list: SessionsResponse = { sessions: [{ id: 'a', title: 'Old' }, { id: 'b', title: 'Other' }], counts: {}, perGroup: 8 }
  qc.setQueryData(queryKeys.sessions.all, list)
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  const titles = () => qc.getQueryData<SessionsResponse>(queryKeys.sessions.all)!.sessions.map((s) => s.title)
  return { ...renderHook(() => useUpdateSession(), { wrapper }), titles }
}

describe('useUpdateSession', () => {
  it('shows a new title in the sessions list before the save resolves', async () => {
    let finish: (value: unknown) => void = () => {}
    updateSession.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
    const { result, titles } = setup()

    let saving: Promise<unknown> = Promise.resolve()
    act(() => { saving = result.current.mutateAsync({ id: 'a', data: { title: 'New' } }) })
    await vi.waitFor(() => expect(titles()).toEqual(['New', 'Other']))
    expect(updateSession).toHaveBeenCalledWith('a', { title: 'New' })

    await act(async () => { finish({}); await saving })
  })
})
