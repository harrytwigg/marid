import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useQueryInvalidation } from '../use-query-invalidation'
import type { GatewayEvent, GatewayEventListener } from '@jinn/gateway-events'

let listener: ((event: string, payload: unknown) => void) | undefined

// One subscribe identity for the whole file: the hook re-subscribes (and drops
// its pending flush) whenever it changes, which a mounted query's own re-render
// must not do.
const subscribe = (next: (event: string, payload: unknown) => void) => {
  const typedNext = next as unknown as GatewayEventListener
  listener = (event, payload) => typedNext({ event, payload } as GatewayEvent)
  return () => { listener = undefined }
}

vi.mock('@/hooks/use-gateway', () => ({
  useGateway: () => ({ subscribe }),
}))

// Proves a MOUNTED surface (a useQuery on a Todo key) refetches when its
// `company:changed` event lands — the live refresh contract, no page reload.
describe('mounted surface refresh on company:changed', () => {
  beforeEach(() => vi.useRealTimers())
  afterEach(() => vi.useRealTimers())

  it('refetches the Todo list when a Todo changes', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const queryFn = vi.fn().mockResolvedValue({ ok: true })
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )

    renderHook(() => {
      useQueryInvalidation()
      useQuery({ queryKey: ['work-items'], queryFn })
    }, { wrapper })

    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1))

    act(() => listener?.('company:changed', {
      entity: 'todo', action: 'archived', id: 'wi_gone', version: 9,
    }))

    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2), { timeout: 4_000 })
  })
})
