import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
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

function mountHooksQueries() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const listFn = vi.fn().mockResolvedValue({ hooks: [], problems: [] })
  const runsFn = vi.fn().mockResolvedValue({ runs: [], nextBefore: null })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  renderHook(() => {
    useQueryInvalidation()
    useQuery({ queryKey: queryKeys.hooks.hooks, queryFn: listFn })
    useQuery({ queryKey: queryKeys.hooks.runs({ hook: '', outcome: '', todo: '' }), queryFn: runsFn })
  }, { wrapper })
  return { listFn, runsFn }
}

// The Hooks page follows the gateway live: a run written or finished, or a
// config reload (hooks live in config.yaml), refetches the list and the log.
describe('hooks live refresh', () => {
  it('refetches the hook list and run log on hooks:run', async () => {
    const { listFn, runsFn } = mountHooksQueries()
    await waitFor(() => expect(runsFn).toHaveBeenCalledTimes(1))

    act(() => listener?.('hooks:run', { id: 'bhr_1', hook: 'review-merge', status: 'ok' }))

    await waitFor(() => expect(runsFn).toHaveBeenCalledTimes(2), { timeout: 4_000 })
    expect(listFn).toHaveBeenCalledTimes(2)
  })

  it('refetches the hook list on config:reloaded', async () => {
    const { listFn } = mountHooksQueries()
    await waitFor(() => expect(listFn).toHaveBeenCalledTimes(1))

    act(() => listener?.('config:reloaded', {}))

    await waitFor(() => expect(listFn).toHaveBeenCalledTimes(2), { timeout: 4_000 })
  })
})
