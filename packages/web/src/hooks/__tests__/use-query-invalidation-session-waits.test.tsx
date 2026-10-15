import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useQueryInvalidation } from '../use-query-invalidation'
import { queryKeys } from '@/lib/query-keys'
import type { GatewayEvent, GatewayEventListener } from '@jinn/gateway-events'

let listener: ((event: string, payload: unknown) => void) | undefined

const subscribe = (next: (event: string, payload: unknown) => void) => {
  const typedNext = next as unknown as GatewayEventListener
  listener = (event, payload) => typedNext({ event, payload } as GatewayEvent)
  return () => { listener = undefined }
}

vi.mock('@/hooks/use-gateway', () => ({
  useGateway: () => ({ subscribe }),
}))

function setup(popupOpen: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const queryFn = vi.fn().mockResolvedValue({ items: [] })
  const invalidated = vi.spyOn(client, 'invalidateQueries')
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  renderHook(() => {
    useQueryInvalidation()
    useQuery({ queryKey: queryKeys.sessionWaits('s-1'), queryFn, enabled: popupOpen })
  }, { wrapper })
  return { queryFn, invalidated }
}

const waitsInvalidations = (invalidated: ReturnType<typeof setup>['invalidated']) =>
  invalidated.mock.calls.filter(([filters]) => filters?.queryKey?.[0] === 'session-waits')

describe('the "waiting on" popup follows the session events', () => {
  afterEach(() => { listener = undefined })

  it('refetches while open when a session changes status anywhere', async () => {
    const { queryFn } = setup(true)
    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1))

    act(() => listener?.('session:completed', { sessionId: 'some-child' }))

    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2), { timeout: 4_000 })
  })

  it("refetches while open when the session's own background activity changes", async () => {
    const { queryFn } = setup(true)
    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1))

    act(() => listener?.('session:background', { sessionId: 's-1', backgroundActivity: null }))

    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2), { timeout: 4_000 })
  })

  it('leaves a background change alone when no popup is open', async () => {
    const { invalidated } = setup(false)

    act(() => listener?.('session:background', { sessionId: 's-1', backgroundActivity: null }))
    await new Promise((resolve) => setTimeout(resolve, 1_300))

    expect(waitsInvalidations(invalidated)).toHaveLength(0)
  })
})
